import { randomUUID } from 'node:crypto';

// A named audience comes only from trusted local configuration, never a request's recipient ID.
export function announcementBinding(bridge, repository, name, create = false) {
  const c = bridge.config, http = c.receiptHttp;
  const target = http?.announcementTargets?.get(`${repository}:${name}`);
  if (!http?.enabled || !http.repositories.has(repository) || !target || !c.allowedChats.has(target)) return null;
  const b = bridge.store.get('SELECT b.*,r.target,r.owner,r.channel,r.kind,r.status FROM announcement_bindings b JOIN requests r ON r.id=b.request WHERE b.repository=? AND b.name=?', repository, name);
  if (b) return b.kind === 'announcement' && b.status === 'sent' && b.target === target && b.owner === c.ownerUser && b.channel === c.slackChannel && b.wecom_bot === c.wecomBotId ? b : null;
  if (!create) return { request: null, target };
  const request = randomUUID();
  bridge.store.run("INSERT INTO requests(id,target,created,expires,status,kind,owner,channel) VALUES (?,?,?,?,'sent','announcement',?,?)", request, target, bridge.now(), Number.MAX_SAFE_INTEGER, c.ownerUser, c.slackChannel);
  bridge.store.run('INSERT INTO announcement_bindings VALUES (?,?,?,?)', request, repository, name, c.wecomBotId);
  return { request, target };
}

export function authorizeAnnouncement(bridge, request) {
  const b = bridge.store.get('SELECT * FROM announcement_bindings WHERE request=?', request.request ?? request.id);
  const current = b && announcementBinding(bridge, b.repository, b.name);
  return !!current?.request && current.request === (request.request ?? request.id) && current.target === (request.original_target ?? request.target);
}
