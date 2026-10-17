import { randomUUID } from 'node:crypto';
import { chunks } from './text.js';
// Render free text as a single JSON string; encode Markdown/mention syntax literally.
const literal = value => JSON.stringify(value).replace(/[<>&`*_\[\]()#]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const fields = ['repo', 'issue_id', 'issue_number', 'title', 'revision', 'proposed_action', 'allowed_scope', 'source_kind'];
export function parseProposal(text, repo) {
  if (!repo || typeof text !== 'string' || Buffer.byteLength(text) > 8192 || !text.startsWith('[wecom:issue]')) return null;
  let p; try { p = JSON.parse(text.slice('[wecom:issue]'.length)); } catch { return null; }
  if (!p || Array.isArray(p) || typeof p !== 'object' || Object.keys(p).length !== fields.length || fields.some(k => !Object.hasOwn(p, k))) return null;
  if (p.repo !== repo || typeof p.issue_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(p.issue_id) || !Number.isSafeInteger(p.issue_number) || p.issue_number < 1 || !Number.isSafeInteger(p.revision) || p.revision < 1 || !['wecom', 'github', 'ai'].includes(p.source_kind)) return null;
  for (const [k, max] of [['title', 300], ['proposed_action', 2000], ['allowed_scope', 1000]]) {
    if (typeof p[k] !== 'string' || !p[k].trim() || Buffer.byteLength(p[k]) > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(p[k])) return null;
  }
  return Object.fromEntries(fields.map(k => [k, p[k]]));
}
export function issueAuthorized(bridge, request) {
  const p = bridge.store.get('SELECT * FROM issue_proposals WHERE request=?', request.request ?? request.id);
  return !!p && !!bridge.config.issueRepository && p.repo === bridge.config.issueRepository && p.owner === bridge.config.ownerUser && p.channel === bridge.config.slackChannel && p.root === request.root;
}
export function receiveIssue(bridge, event) {
  const { store, config: c } = bridge; const now = bridge.now();
  const p = parseProposal(event.text, c.issueRepository); if (!p) return false;
  const snapshot = JSON.stringify(p);
  const inserted = store.transaction(() => {
    // GitHub immutable ID and human-facing number must stay bound in both directions.
    if (store.get('SELECT id FROM issue_proposals WHERE repo=? AND ((issue_id=? AND issue_number!=?) OR (issue_number=? AND issue_id!=?))', p.repo, p.issue_id, p.issue_number, p.issue_number, p.issue_id)) return false;
    const latest = store.get('SELECT * FROM issue_proposals WHERE repo=? AND issue_id=? ORDER BY revision DESC LIMIT 1', p.repo, p.issue_id);
    // Includes identical redeliveries, conflicting same-version bodies, and stale versions.
    if (latest && p.revision <= latest.revision) return false;
    if (store.get('SELECT id FROM requests WHERE root=?', event.ts)) return false;
    const id = randomUUID(), review = randomUUID();
    const pending = store.all("SELECT request FROM issue_proposals WHERE repo=? AND issue_id=? AND status='pending'", p.repo, p.issue_id);
    for (const old of pending) store.run("UPDATE jobs SET status='superseded' WHERE request=? AND direction='wecom' AND status='pending'", old.request);
    store.run("UPDATE issue_proposals SET status='superseded' WHERE repo=? AND issue_id=? AND status='pending'", p.repo, p.issue_id);
    store.run('INSERT INTO requests(id,source,target,created,expires,root,status,kind,owner,channel) VALUES (?,?,?,?,?,?,?,?,?,?)', id, `issue:${review}`, c.ownerUser, now, now + c.ttlMs, event.ts, 'sent', 'issue', c.ownerUser, c.slackChannel);
    store.run('INSERT INTO issue_proposals VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', review, id, p.repo, p.issue_id, p.issue_number, p.revision, snapshot, c.ownerUser, c.slackChannel, event.ts, now, 'pending');
    const text = `问题决策请求：本阶段仅记录决定，不会自动修改代码或部署\n${p.repo} #${p.issue_number} · 版本 ${p.revision}\nhttps://github.com/${p.repo}/issues/${p.issue_number}\n来源：${p.source_kind}\n标题：${literal(p.title)}\n建议操作：${literal(p.proposed_action)}\n允许范围：${literal(p.allowed_scope)}`;
    const footer = `\n\n请在本私聊复制其中一行，可在末尾空格后添加单行理由：\n/review ${review} 同意\n/review ${review} 不同意\n/review ${review} 暂缓\n只记录一次决定；暂缓后须提交更高版本才能重新决策。decision_record_only=true`;
    const parts = chunks(text, 3400);
    if (Buffer.byteLength(parts.at(-1) + footer) <= 3400) parts[parts.length - 1] += footer;
    else parts.push(footer.trimStart());
    parts.forEach(text => store.addJob(id, 'wecom', { text }, 'owner', c.ownerUser, now + c.ttlMs));
    return true;
  });
  if (inserted) bridge.drain(); return inserted;
}
// Called within the authenticated owner ingress transaction. No expiry is applied to audit records.
export function decideIssue(bridge, review, words, source, now) {
  const { store, config: c } = bridge;
  const p = store.get('SELECT * FROM issue_proposals WHERE id=?', review);
  if (!p) return null;
  const m = /^(同意|不同意|暂缓)(?: ([^\r\n]+))?$/.exec(words);
  if (!m || Buffer.byteLength(m[2] || '') > 1000 || /[\x00-\x1f\x7f]/.test(m[2] || '') || p.status !== 'pending' || !c.issueRepository || p.repo !== c.issueRepository || p.owner !== c.ownerUser || p.channel !== c.slackChannel) return false;
  if (store.get('SELECT proposal FROM issue_decisions WHERE source=?', source)) return false;
  const decision = { '同意': 'approve', '不同意': 'reject', '暂缓': 'defer' }[m[1]];
  const reason = m[2] || '';
  store.run('INSERT INTO issue_decisions VALUES (?,?,?,?,?,?)', p.id, decision, reason, c.ownerUser, source, now);
  store.run("UPDATE issue_proposals SET status='decided' WHERE id=?", p.id);
  // Never execute a decision. The outbox only reports it to the authoritative root thread.
  const metadata = { event_type: 'wecom_bridge_issue_decision', event_payload: { request_id: p.request, review_id: p.id, repo: p.repo, issue_id: p.issue_id, issue_number: p.issue_number, revision: p.revision, decision, reason, decision_record_only: true } };
  const record = JSON.stringify(metadata.event_payload).replace(/[<>&]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  store.addJob(p.request, 'slack', { part: 1, parts: 1, metadata, text: `Issue decision record\n${record}\n问题 #${p.issue_number} · 版本 ${p.revision}：已记录${m[1]}。\n本阶段仅记录决定，不会自动修改代码或部署。decision_record_only=true` }, 'slack', c.slackChannel, now + c.ttlMs);
  return p.request;
}
