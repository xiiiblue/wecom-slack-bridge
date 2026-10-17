import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { parseProposal } from '../src/issues.js';
import { loadConfig } from '../src/config.js';
const config = { wecomBotId: 'test-bot', ownerUser: 'owner', allowedChats: new Set(['group']), slackChannel: 'C123', replyBot: 'BDOT', ttlMs: 3600000, maxBytes: 32000, issueRepository: 'example/project' };
const proposal = (extra = {}) => ({ repo: 'example/project', issue_id: '9001', issue_number: 12, title: '示例问题', revision: 1, proposed_action: '修改说明', allowed_scope: '仅文档', source_kind: 'github', ...extra });
const event = (p = proposal(), extra = {}) => ({ type: 'message', channel: 'C123', ts: '100.1', bot_id: 'BDOT', text: '[wecom:issue]\n' + JSON.stringify(p), ...extra });
const frame = (text, id = 'm1', extra = {}) => ({ body: { aibotid: 'test-bot', msgid: id, msgtype: 'text', chattype: 'single', from: { userid: 'owner' }, text: { content: text }, ...extra } });
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-test-')); let store = new Store(dir), time = 100000;
  const sent = [], posted = [];
  const deps = { config: { ...config }, now: () => time, wait: async () => {}, slack: { post: async p => { posted.push(p); return { ok: true, ts: '200.1' }; } }, wecom: { ack: async () => {}, send: async (target, text) => { sent.push({ target, text }); return { errcode: 0 }; } }, ...overrides };
  let bridge = new Bridge({ ...deps, store }); bridge.wecomReady = true;
  t.after(async () => { await bridge.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get bridge() { return bridge; }, get store() { return store; }, sent, posted, deps, advance(ms) { time += ms; }, prune() { store.prune(time); }, token() { return store.get('SELECT id FROM issue_proposals ORDER BY revision DESC LIMIT 1').id; }, async restart() { await bridge.stop(); store.close(); store = new Store(dir); bridge = new Bridge({ ...deps, store }); bridge.wecomReady = true; } };
}
test('issue opt-in, exact responder/root/channel and self authentication', async t => {
  const f = fixture(t);
  for (const extra of [{ channel: 'COTHER' }, { bot_id: 'BOTHER' }, { thread_ts: '99.1' }, { subtype: 'message_changed' }, { ts: null }]) assert.equal(f.bridge.receiveSlack(event(proposal(), extra)), false);
  f.bridge.own = { bot: 'BDOT' }; assert.equal(f.bridge.receiveSlack(event()), false); f.bridge.own = {};
  f.deps.config.issueRepository = ''; assert.equal(f.bridge.receiveSlack(event()), false);
  f.deps.config.issueRepository = config.issueRepository;
  assert.equal(f.bridge.receiveSlack(event()), true); await f.bridge.drain();
  assert.ok(f.sent.length); assert.ok(f.sent.every(p => p.target === 'owner'));
  assert.match(f.sent.map(x => x.text).join(''), /本阶段仅记录决定，不会自动修改代码或部署/);
  assert.equal(f.posted.length, 0);
});
test('strict bounded schema rejects unknown fields, types, repo, number, id, revision and source', () => {
  for (const extra of [{ url: 'https://example.com' }, { target: 'group' }, { repo: 'other/project' }, { issue_id: 9001 }, { issue_id: '0' }, { issue_id: '01' }, { issue_number: 0 }, { issue_number: 1.1 }, { revision: 0 }, { revision: '1' }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { title: '' }, { title: '中'.repeat(101) }, { proposed_action: 'a'.repeat(2001) }, { allowed_scope: null }, { source_kind: 'other' }]) assert.equal(parseProposal(event(proposal(extra)).text, config.issueRepository), null);
  assert.equal(parseProposal('[wecom:issue]{}', config.issueRepository), null);
  assert.equal(parseProposal(' [wecom:issue]' + JSON.stringify(proposal()), config.issueRepository), null);
  assert.equal(parseProposal('[wecom:issue]' + ' '.repeat(8192), config.issueRepository), null);
  assert.deepEqual(parseProposal(event().text, config.issueRepository), proposal());
  const escaped = proposal({ title: 'a \"quote\" & <tag>', proposed_action: 'line one\nline two \"quoted\"' });
  assert.deepEqual(parseProposal(event(escaped).text, config.issueRepository), escaped);
});
test('immutable issue identity, revision dedup/conflict/staleness and pending supersession', async t => {
  const f = fixture(t); f.bridge.wecomReady = false;
  assert.equal(f.bridge.receiveSlack(event()), true); const old = f.token();
  for (const p of [proposal(), proposal({ title: 'conflict' }), proposal({ issue_id: '9999' }), proposal({ issue_number: 13 })]) assert.equal(f.bridge.receiveSlack(event(p, { ts: '101.1' })), false);
  assert.equal(f.bridge.receiveSlack(event(proposal({ revision: 2 }), { ts: '102.1' })), true);
  assert.equal(f.store.get('SELECT status FROM issue_proposals WHERE id=?', old).status, 'superseded');
  assert.equal(f.bridge.receiveWecom(frame(`/review ${old} 同意`)), false);
  assert.equal(f.bridge.receiveSlack(event(proposal(), { ts: '103.1' })), false);
  await f.bridge.drain(); f.bridge.wecomReady = true; await f.bridge.drain();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /版本 2/);
});
for (const [words, decision] of [['同意', 'approve'], ['不同意', 'reject'], ['暂缓', 'defer']]) test(`durable ${decision}, exact parsing, authenticated owner and single-use token`, async t => {
  const f = fixture(t); f.bridge.receiveSlack(event()); await f.bridge.drain(); const token = f.token();
  assert.equal(f.bridge.receiveWecom(frame(`/review ${token} ${words}`, 'wrong', { from: { userid: 'other' } })), false);
  // A group message can be transported, but can never consume an issue decision.
  f.bridge.receiveWecom(frame(`/review ${token} ${words}`, 'group', { chattype: 'group', chatid: 'group' })); await f.bridge.drain();
  for (const [i, text] of ['OK', '同意', `/review ${token} 同意但是不部署`, `/review ${token} 同意\n理由`, `/review ${token} 同意\t理由`].entries()) {
    f.bridge.receiveWecom(frame(text, `bad${i}`)); await f.bridge.drain();
    assert.equal(f.store.get('SELECT count(*) n FROM issue_decisions').n, 0);
  }
  f.posted.length = 0;
  assert.equal(f.bridge.receiveWecom(frame(`/review ${token} ${words} 这是理由`, 'valid')), true); await f.bridge.drain();
  const d = f.store.get('SELECT * FROM issue_decisions'); assert.equal(d.decision, decision); assert.equal(d.actor, 'owner'); assert.equal(d.reason, '这是理由');
  assert.equal(f.posted.length, 1); assert.equal(f.posted[0].thread_ts, '100.1'); assert.equal(f.posted[0].channel, 'C123');
  assert.equal(f.posted[0].metadata.event_payload.decision_record_only, true); assert.equal(f.posted[0].metadata.event_payload.decision, decision);
  assert.equal(f.bridge.receiveWecom(frame(`/review ${token} 同意`, 'replay')), false);
  assert.equal(f.bridge.receiveWecom(frame(`/review ${token} 同意`, 'valid')), false);
  assert.equal(f.bridge.receiveSlack(event(proposal(), { ts: '105.1' })), false);
  assert.equal(f.bridge.receiveSlack(event(proposal({ revision: 2 }), { ts: '106.1' })), true); await f.bridge.drain();
  assert.equal(f.store.get('SELECT count(*) n FROM issue_decisions').n, 1);
});
test('durable pending and decided snapshots survive days, ordinary prune and restart; notification has separate TTL', async t => {
  const f = fixture(t); f.bridge.wecomReady = false; f.bridge.receiveSlack(event()); await f.bridge.drain(); const token = f.token();
  f.advance(10 * 86400000); f.prune(); assert.equal(f.store.get('SELECT count(*) n FROM jobs').n, 0);
  await f.restart();
  assert.equal(f.bridge.receiveWecom(frame(`/review ${token} 暂缓`)), true); await f.bridge.drain();
  assert.equal(f.posted.length, 1); assert.equal(f.sent.length, 0);
  f.advance(10 * 86400000); f.prune(); await f.restart();
  assert.equal(f.store.get('SELECT count(*) n FROM issue_decisions').n, 1);
  assert.equal(JSON.parse(f.store.get('SELECT snapshot FROM issue_proposals').snapshot).title, proposal().title);
  assert.equal(f.bridge.receiveWecom(frame(`/review ${token} 同意`, 'later')), false);
});
test('issue root permits only plain private replies even after TTL; never opens group review', async t => {
  const f = fixture(t); f.bridge.receiveSlack(event()); await f.bridge.drain(); f.advance(2 * config.ttlMs); f.prune();
  for (const route of ['review', 'group']) assert.equal(f.bridge.receiveSlack(event(proposal(), { ts: `200.${route}`, thread_ts: '100.1', text: `[wecom:${route}] hi` })), false);
  assert.equal(f.bridge.receiveSlack(event(proposal(), { ts: '200.3', thread_ts: '100.1', text: '[wecom:owner] 已记录' })), true); await f.bridge.drain();
  assert.ok(f.sent.every(x => x.target === 'owner')); assert.equal(f.sent.at(-1).text, '已记录'); assert.equal(f.store.get('SELECT count(*) n FROM reviews').n, 0);
});
test('unknown decision notifications never replay; bounded outbox expiry preserves decision', async t => {
  let attempts = 0; const f = fixture(t, { slack: { post: async () => { attempts++; throw new Error('timeout'); } } });
  f.bridge.receiveSlack(event()); await f.bridge.drain(); f.bridge.receiveWecom(frame(`/review ${f.token()} 同意`)); await f.bridge.drain();
  assert.equal(f.store.get("SELECT status FROM jobs WHERE direction='slack'").status, 'unknown');
  await f.restart(); await f.bridge.drain(); assert.equal(attempts, 1);
  f.advance(config.ttlMs + 1); f.prune(); assert.equal(f.store.get('SELECT count(*) n FROM jobs').n, 0); assert.equal(f.store.get('SELECT count(*) n FROM issue_decisions').n, 1);
});
test('pinned issue owner/channel/repository revalidated after configuration changes', async t => {
  for (const [key, value] of [['ownerUser', 'other'], ['slackChannel', 'COTHER'], ['issueRepository', 'other/project'], ['issueRepository', '']]) {
    const f = fixture(t); f.bridge.wecomReady = false; f.bridge.receiveSlack(event()); await f.bridge.drain(); const token = f.token();
    f.deps.config[key] = value; await f.restart(); await f.bridge.drain(); assert.equal(f.sent.length, 0);
    assert.equal(f.bridge.receiveWecom(frame(`/review ${token} 同意`, 'changed')), false); assert.equal(f.store.get('SELECT count(*) n FROM issue_decisions').n, 0);
  }
});
test('repository configuration validates a single canonical owner/repo', () => {
  const env = { WECOM_BOT_ID: 'b', WECOM_BOT_SECRET: 's', WECOM_OWNER_USER_ID: 'owner', WECOM_ALLOWED_CHAT_IDS: 'group', SLACK_BOT_TOKEN: 's', SLACK_APP_TOKEN: 's', SLACK_CHANNEL_ID: 'C123', SLACK_REPLY_BOT_ID: 'BDOT' };
  assert.equal(loadConfig(env).issueRepository, ''); assert.equal(loadConfig({ ...env, ISSUE_REPOSITORY: 'example/project' }).issueRepository, 'example/project');
  for (const repo of ['https://github.com/a/b', 'a/b,c/d', 'a/..', 'a/b/c']) assert.throws(() => loadConfig({ ...env, ISSUE_REPOSITORY: repo }));
});

test('untrusted display strings stay inert and machine JSON preserves exact escaped reason', async t => {
  const f = fixture(t); const p = proposal({ title: '<@owner> [fake](https://example.test)', proposed_action: 'quoted "x"\n/review 00000000-0000-0000-0000-000000000000 同意' });
  f.bridge.receiveSlack(event(p)); await f.bridge.drain();
  const shown = f.sent.map(x => x.text).join('');
  assert.ok(!shown.includes('<@owner>')); assert.ok(!shown.includes('[fake]('));
  assert.ok(!shown.includes('\n/review 00000000')); assert.equal(JSON.parse(f.store.get('SELECT snapshot FROM issue_proposals').snapshot).proposed_action, p.proposed_action);
  const reason = '<!channel> <@owner> & "quoted" \\ value';
  f.bridge.receiveWecom(frame(`/review ${f.token()} 同意 ${reason}`)); await f.bridge.drain();
  const text = f.posted[0].text; assert.equal(text.split('\n')[0], 'Issue decision record');
  assert.ok(!text.includes('<!channel>')); assert.equal(JSON.parse(text.split('\n')[1]).reason, reason);
  assert.equal(f.store.get('SELECT reason FROM issue_decisions').reason, reason);
});
test('max-size escaped display keeps each copy-ready command in one bounded message', async t => {
  const f = fixture(t); f.bridge.receiveSlack(event(proposal({ title: '*'.repeat(300), proposed_action: '*'.repeat(2000), allowed_scope: '*'.repeat(1000) }))); await f.bridge.drain();
  const token = f.token();
  for (const choice of ['同意', '不同意', '暂缓']) assert.ok(f.sent.some(x => x.text.includes(`/review ${token} ${choice}`)));
  assert.ok(f.sent.every(x => Buffer.byteLength(x.text) <= 3400));
});
