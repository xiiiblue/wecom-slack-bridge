import { randomUUID, createHash } from 'node:crypto';
import { slackDecode } from './text.js';
const digest = text => createHash('sha256').update(text).digest('hex');
const referenceAllowed = (c, b) => c.feedbackRepositories?.has(b.repository) && !!c.replyBot && b.bot === c.replyBot && !!c.feedbackUser && b.responder_user === c.feedbackUser && b.wecom_bot === c.wecomBotId;
// Shared admission for trusted transports; never creates or retargets a binding.
export function feedbackBinding(bridge, repository, issue) {
  const b = bridge.store.get('SELECT b.*,r.target,r.owner,r.channel,r.kind,r.status FROM feedback_bindings b JOIN requests r ON r.id=b.request WHERE b.repository=? AND b.issue=?', repository, issue);
  const c = bridge.config;
  return b && b.kind === 'feedback' && b.status === 'sent' && b.owner === c.ownerUser && b.channel === c.slackChannel && referenceAllowed(c,b) && c.allowedChats.has(b.target) ? b : null;
}
export function feedbackDelivery(store, deliveryId) {
  return store.get('SELECT d.*,j.status FROM feedback_deliveries d JOIN jobs j ON j.id=d.job WHERE delivery_id=?',deliveryId);
}
// Caller holds the same store transaction as its binding check.
export function putFeedbackDelivery(store, binding, deliveryId, text) {
  const fingerprint = digest(text), prior = feedbackDelivery(store, deliveryId);
  if (prior) return prior.request === binding.request && prior.digest === fingerprint;
  const result = store.run('INSERT INTO jobs(request,direction,payload,lane,target) VALUES (?,?,?,?,?)',binding.request,'wecom',JSON.stringify({part:1,parts:1,text}),'group',binding.target);
  store.run('INSERT INTO feedback_deliveries VALUES (?,?,?,?)',deliveryId,binding.request,fingerprint,Number(result.lastInsertRowid));
  return true;
}
export function authorizeFeedback(bridge, request) {
  const b = bridge.store.get('SELECT * FROM feedback_bindings WHERE request=?', request.request ?? request.id);
  return !!b && (b.active || (request.direction === 'slack' && (request.lane === 'feedback_receipt' || request.lane?.startsWith('feedback_query:')))) && referenceAllowed(bridge.config, b) && bridge.config.allowedChats.has(request.original_target ?? request.target);
}
// Generic immutable source association. Business evidence and public-content review belong to the responder.
export function receiveFeedback(bridge, event) {
  const {store, config: c} = bridge;
  if (!c.replyBot || event.bot_id !== c.replyBot || !c.feedbackUser || event.user !== c.feedbackUser || Buffer.byteLength(event.text) > 12000) return false;
  const match = /^\[wecom:source-(bind|binding-status|result|status|revoke)\]([\s\S]+)$/.exec(event.text);
  let p; try { p = JSON.parse(match[2]); } catch { return false; }
  const action = match[1], fields = action === 'result' ? ['repository','issue','deliveryId','text'] : action === 'status' ? ['repository','issue','deliveryId'] : ['repository','issue'];
  if (!p || Array.isArray(p) || Object.keys(p).length !== fields.length || fields.some(k => !Object.hasOwn(p,k)) ||
      !c.feedbackRepositories?.has(p.repository) || !Number.isSafeInteger(p.issue) || p.issue < 1) return false;
  if (['result','status'].includes(action) && (typeof p.deliveryId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.deliveryId))) return false;
  if (action === 'result' && (typeof p.text !== 'string' || !p.text.trim() || Buffer.byteLength(p.text) > 3000)) return false;
  const commandSource = digest(`${event.channel}:${event.ts}`), commandDigest = digest(event.text);
  const accepted = store.transaction(() => {
    const prior = store.get('SELECT digest FROM feedback_commands WHERE source=?', commandSource);
    if (prior) return prior.digest === commandDigest;
    const result = processCommand();
    if (result) store.run('INSERT INTO feedback_commands VALUES (?,?)', commandSource, commandDigest);
    return result;
  });
  if (accepted) bridge.drain();
  return accepted;

  function processCommand() {
    const now = bridge.now();
    let b = store.get('SELECT b.*,r.target,r.owner,r.channel FROM feedback_bindings b JOIN requests r ON r.id=b.request WHERE b.repository=? AND b.issue=?', p.repository,p.issue);
    const receipt = text => store.addJob(b.request, 'slack', {part:1,parts:1,text}, ['status','binding-status'].includes(action) ? `feedback_query:${commandSource}` : 'feedback_receipt', c.slackChannel);
    if (action === 'bind' && !b) {
      const r = store.get("SELECT * FROM requests WHERE root=? AND kind='group'",event.thread_ts);
      if (!r || r.status !== 'sent' || r.expires <= now || !r.source?.startsWith('wecom:') || r.ingress_bot !== c.wecomBotId || !bridge.authorizedRequest(r)) return false;
      const id = randomUUID();
      store.run("INSERT INTO requests(id,source,target,created,expires,status,kind,owner,channel) VALUES (?,NULL,?,?,?,'sent','feedback',?,?)",id,r.target,now,Number.MAX_SAFE_INTEGER,r.owner,r.channel);
      store.run('INSERT INTO feedback_bindings(request,repository,issue,source,root,bot,responder_user,wecom_bot) VALUES (?,?,?,?,?,?,?,?)',id,p.repository,p.issue,r.source,r.root,c.replyBot,c.feedbackUser,c.wecomBotId);
      b = {request:id}; receipt(`source_bound | ${p.repository}#${p.issue} | original audience pinned`); return true;
    }
    if (!b || (!b.active && !['status','binding-status'].includes(action)) || b.root !== event.thread_ts || b.owner !== c.ownerUser || b.channel !== c.slackChannel || !referenceAllowed(c,b) || !c.allowedChats.has(b.target)) return false;
    if (action === 'binding-status') {
      receipt(`source_binding | ${p.repository}#${p.issue} | bound | binding_active=${b.active}`);
      return true;
    }
    if (action === 'bind') return true; // Immutable, idempotent; never retarget.
    if (action === 'revoke') {
      store.run('UPDATE feedback_bindings SET active=0 WHERE request=?',b.request);
      store.run("UPDATE jobs SET status='revoked' WHERE request=? AND direction='wecom' AND status='pending'",b.request);
      receipt(`source_revoked | ${p.repository}#${p.issue}`);
      return true;
    }
    const d = feedbackDelivery(store,p.deliveryId);
    if (action === 'status') {
      if (d && d.request !== b.request) return false;
      receipt(`source_delivery | ${p.deliveryId} | ${d?.status === 'sent' ? 'wecom_ack' : d?.status || 'not_found'} | binding_active=${b.active} | ACK does not prove audience read`); return true;
    }
    const text = slackDecode(p.text);
    if (d) return putFeedbackDelivery(store,b,p.deliveryId,text);
    // One bounded plain-text message avoids partial multipart delivery. Unknown stays blocked across restart.
    putFeedbackDelivery(store,b,p.deliveryId,text);
    receipt(`source_delivery | ${p.deliveryId} | accepted | queued locally; not a WeCom ACK`);
    return true;
  }
}
