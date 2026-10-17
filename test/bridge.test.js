import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Bridge, allowedReply } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { chunks } from '../src/text.js';

const config = { wecomBotId: 'test-bot', ownerUser: 'alice', allowedChats: new Set(['group-2']), slackChannel: 'C123', replyBot: 'BDOT', ttlMs: 3600000, maxBytes: 32000 };
const frame = (id = 'm1', user = 'alice', extra = {}) => ({ headers: { req_id: `r-${id}` }, body: { aibotid: 'test-bot', msgid: id, msgtype: 'text', chattype: 'single', from: { userid: user }, text: { content: 'Hello 世界 😀' }, ...extra } });
const reply = (extra = {}) => ({ type: 'message', channel: 'C123', thread_ts: '100.1', ts: '100.2', subtype: 'bot_message', bot_id: 'BDOT', text: '[wecom:owner]\nReply 世界 😀', ...extra });
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  let store = new Store(dir); const posted = [], sent = [], logs = []; let time = 100000;
  const dependencies = { config, wait: async () => {}, slack: { post: async p => { posted.push(p); return { ok: true, ts: `100.${posted.length}` }; } }, wecom: { ack: async () => {}, send: async (target, text) => { sent.push({ target, text }); return { errcode: 0 }; } }, log: (...args) => logs.push(args), now: () => time, ...overrides };
  let bridge = new Bridge({ ...dependencies, store }); bridge.wecomReady = true;
  t.after(async () => { await bridge.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get bridge() { return bridge; }, get store() { return store; }, dir, posted, sent, logs, advance(ms) { time += ms; }, async restart() { await bridge.stop(); store.close(); store = new Store(dir); bridge = new Bridge({ ...dependencies, store }); bridge.wecomReady = true; } };
}

test('author, channel, subtype, root and self filters fail closed', () => {
  assert.equal(allowedReply(reply(), config), true);
  for (const e of [reply({ bot_id: 'BOTHER' }), reply({ channel: 'COTHER' }), reply({ thread_ts: undefined }), reply({ thread_ts: '100.2' }), reply({ subtype: 'message_changed' }), reply({ text: '' })]) assert.equal(allowedReply(e, config), false);
  assert.equal(allowedReply(reply(), config, { bot: 'BDOT' }), false);
  const userConfig = { ...config, replyBot: undefined, replyUser: 'UDOT' };
  assert.equal(allowedReply(reply({ bot_id: undefined, subtype: undefined, user: 'UDOT' }), userConfig), true);
  assert.equal(allowedReply(reply({ user: 'UDOT' }), userConfig), false);
});

test('allowlisted text roundtrip maps only original thread to original user', async t => {
  const f = fixture(t);
  assert.equal(f.bridge.receiveWecom(frame('bad', 'mallory')), false);
  assert.equal(f.bridge.receiveWecom(frame('bad2', 'alice', { msgtype: 'image' })), false);
  assert.equal(f.bridge.receiveWecom(frame()), true); await f.bridge.drain();
  assert.equal(f.posted.length, 1); assert.match(f.posted[0].text, /Untrusted relayed content/);
  assert.equal(f.posted[0].mrkdwn, false); assert.equal(f.posted[0].unfurl_links, false);
  assert.equal(f.bridge.receiveSlack(reply({ thread_ts: '999.9' }), 'Ev0'), false);
  assert.equal(f.bridge.receiveSlack(reply(), 'Ev1'), true); await f.bridge.drain();
  assert.deepEqual(f.sent, [{ target: 'alice', text: 'Reply 世界 😀' }]);
});

test('per-message mapping prevents conversation cross-talk', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(frame('one')); await f.bridge.drain();
  f.bridge.receiveWecom(frame('two', 'alice', { chattype: 'group', chatid: 'group-2' })); await f.bridge.drain();
  f.bridge.receiveSlack(reply({ thread_ts: '100.2', ts: '200.2', text: '[wecom:group]\nGroup response' })); await f.bridge.drain();
  f.bridge.receiveSlack(reply({ thread_ts: '100.1', ts: '200.1' })); await f.bridge.drain();
  assert.deepEqual(f.sent.map(x => x.target), ['group-2', 'alice']);
});

test('dedup survives restart; changing event envelope does not duplicate Slack delivery', async t => {
  const f = fixture(t); f.bridge.receiveWecom(frame()); await f.bridge.drain();
  f.bridge.receiveSlack(reply(), 'Ev1'); await f.bridge.drain(); await f.restart();
  assert.equal(f.bridge.receiveWecom(frame()), false);
  assert.equal(f.bridge.receiveSlack(reply(), 'EvDifferent'), false);
  await f.bridge.drain(); assert.equal(f.posted.length, 1); assert.equal(f.sent.length, 1);
  f.bridge.receiveSlack(reply({ ts: '100.3', text: '[wecom:owner]\nLater response' }), 'Ev2'); await f.bridge.drain();
  assert.equal(f.sent.length, 2);
});

test('unknown send outcomes are quarantined, never automatically retried', async t => {
  let attempts = 0;
  const f = fixture(t, { slack: { post: async () => { attempts++; throw new Error('Network timeout with secret that must not be logged'); } } });
  f.bridge.receiveWecom(frame()); await f.bridge.drain();
  assert.equal(f.store.get('SELECT status FROM jobs').status, 'unknown');
  await f.restart(); await f.bridge.drain(); assert.equal(attempts, 1);
  assert.ok(!JSON.stringify(f.logs).includes('secret'));
});

test('pending work resumes, but in-flight work at crash becomes unknown', async t => {
  const f = fixture(t);
  f.bridge.running = Promise.resolve(); f.bridge.receiveWecom(frame());
  assert.equal(f.store.get('SELECT status FROM jobs').status, 'pending');
  await f.restart(); await f.bridge.drain(); assert.equal(f.posted.length, 1);
  f.store.addJob(f.store.get('SELECT id FROM requests').id, 'wecom', { text: 'uncertain' });
  f.store.run("UPDATE jobs SET status='sending' WHERE direction='wecom'");
  await f.restart(); await f.bridge.drain(); assert.equal(f.sent.length, 0);
  assert.equal(f.store.get("SELECT status FROM jobs WHERE direction='wecom'").status, 'unknown');
});

test('TTL prevents late replies and expires pending sends', async t => {
  const f = fixture(t); f.bridge.receiveWecom(frame()); await f.bridge.drain(); f.advance(config.ttlMs + 1);
  assert.equal(f.bridge.receiveSlack(reply()), false);
  f.store.prune(100000 + config.ttlMs + 1); assert.equal(f.store.get('SELECT count(*) n FROM requests').n, 0);
  assert.equal(f.bridge.receiveWecom(frame()), false); // tombstone outlives routing map
});

test('UTF-8 chunks retain complete content and inbound uses one root', async t => {
  const text = '中文😀<&>'.repeat(6000); const parts = chunks(text, 3400);
  assert.equal(parts.join(''), text); assert.ok(parts.every(x => Buffer.byteLength(x) <= 3400 && !x.includes('\uFFFD')));
  const f = fixture(t); f.bridge.receiveWecom(frame('long', 'alice', { text: { content: '中😀'.repeat(3000) } })); await f.bridge.drain();
  assert.equal(f.posted.length, 1); assert.equal(f.posted[0].thread_ts, undefined);
  f.bridge.receiveSlack(reply({ text: '[wecom:owner]\n' + '😀'.repeat(3000) })); await f.bridge.drain();
  assert.ok(f.sent.length > 1); assert.ok(f.sent.every(x => Buffer.byteLength(x.text) <= 3500));
});

test('one active process per state directory', t => {
  const f = fixture(t); assert.throws(() => new Store(f.dir), /locked/);
});

test('required configuration is strict', () => {
  const env = { WECOM_BOT_ID: 'bot', WECOM_BOT_SECRET: 'placeholder', WECOM_OWNER_USER_ID: 'alice', WECOM_ALLOWED_CHAT_IDS: 'group-2', SLACK_BOT_TOKEN: 'placeholder', SLACK_APP_TOKEN: 'placeholder', SLACK_CHANNEL_ID: 'C123', SLACK_REPLY_BOT_ID: 'B123' };
  assert.equal(loadConfig(env).ttlMs, 3600000);
  assert.throws(() => loadConfig({ ...env, WECOM_OWNER_USER_ID: '' }));
  assert.throws(() => loadConfig({ ...env, WECOM_ALLOWED_CHAT_IDS: '' }));
  assert.throws(() => loadConfig({ ...env, WECOM_ALLOWED_CHAT_IDS: 'alice' }));
  assert.throws(() => loadConfig({ ...env, SLACK_REPLY_USER_ID: 'U123' }));
  assert.throws(() => loadConfig({ ...env, REPLY_TTL_SECONDS: '999999' }));
});

test('oversize input receives an explicit rejection and never posts to Slack', async t => {
  const receipts = [];
  const f = fixture(t, { wecom: { ack: async (...args) => receipts.push(args), send: async () => ({ errcode: 0 }) } });
  assert.equal(f.bridge.receiveWecom(frame('large', 'alice', { text: { content: 'x'.repeat(32001) } })), false);
  assert.equal(f.bridge.receiveWecom(frame('escaped', 'alice', { text: { content: '&'.repeat(7000) } })), false);
  await Promise.resolve(); await f.bridge.drain();
  assert.equal(f.posted.length, 0); assert.equal(receipts.length, 2);
  assert.ok(receipts.every(x => x[2].includes('未转发')));
});

test('global Slack pacing reserves a gap across independent requests', async t => {
  const waits = []; const f = fixture(t, { wait: async ms => waits.push(ms) });
  f.bridge.receiveWecom(frame('pace1')); await f.bridge.drain();
  f.bridge.receiveWecom(frame('pace2')); await f.bridge.drain();
  assert.equal(waits[0], 0); assert.ok(waits[1] > 1000 && waits[1] <= 1100);
});

test('group allowlist does not limit owner private messages', async t => {
  const f = fixture(t, { config: { ...config, allowedChats: new Set(['allowed-group']) } });
  assert.equal(f.bridge.receiveWecom(frame('single')), true);
  assert.equal(f.bridge.receiveWecom(frame('group-no', 'alice', { chattype: 'group', chatid: 'other' })), false);
  assert.equal(f.bridge.receiveWecom(frame('group-yes', 'alice', { chattype: 'group', chatid: 'allowed-group' })), true);
  await f.bridge.drain(); assert.equal(f.posted.length, 2);
});

test('disconnected WeCom defers replies; TTL expires queued work without sending', async t => {
  const f = fixture(t); f.bridge.receiveWecom(frame()); await f.bridge.drain();
  f.bridge.wecomReady = false; f.bridge.receiveSlack(reply()); await f.bridge.drain();
  assert.equal(f.sent.length, 0); assert.equal(f.store.get("SELECT status FROM jobs WHERE direction='wecom'").status, 'pending');
  f.advance(config.ttlMs + 1); f.bridge.wecomReady = true; await f.bridge.drain();
  assert.equal(f.sent.length, 0); assert.equal(f.store.get("SELECT status FROM jobs WHERE direction='wecom'").status, 'expired');
});

const group = (id, user = 'member', extra = {}) => frame(id, user, { chattype: 'group', chatid: 'group-2', ...extra });
const routed = (root, ts, route, text = 'Response') => reply({ thread_ts: root, ts, text: `[wecom:${route}]\n${text}` });
const reviewId = f => f.store.get("SELECT id FROM reviews WHERE status='pending' ORDER BY rowid DESC").id;

test('all authenticated group members accepted; unknown groups, missing sender, nonowner DM rejected', async t => {
  const f = fixture(t);
  for (const message of [group('g1'), group('g2', 'another')]) assert.equal(f.bridge.receiveWecom(message), true);
  for (const message of [group('bad', 'member', { chatid: 'unknown' }), group('bad2', ''), frame('dm', 'member'), group('bad3', 'member', { aibotid: 'wrong' })]) assert.equal(f.bridge.receiveWecom(message), false);
  await f.bridge.drain(); assert.equal(f.posted.length, 2);
  assert.match(f.posted[0].text, /"sender":"member"/);
  assert.match(f.posted[0].text, /not an authorization/);
});

test('strict leading-marker route rejects implicit/public routing, forged authors and owner-root group routing', async t => {
  const f = fixture(t); f.bridge.receiveWecom(frame()); await f.bridge.drain();
  for (const text of ['No route', ' [wecom:owner]\nX', '[wecom:unknown]\nX', '[wecom:group]\nprivate', '[wecom:group]private', '[wecom:group] private', '\n[wecom:owner]X', '[wecom:Owner]X', '[wecom:owner-extra]X', '[wecom:owner]\n  ', 'prefix\n[wecom:owner]\nX']) assert.equal(f.bridge.receiveSlack(reply({ text })), false);
  assert.equal(f.bridge.receiveSlack(reply({ bot_id: 'BOTHER' })), false);
  assert.equal(f.bridge.receiveSlack(reply({ channel: 'COTHER' })), false);
  await f.bridge.drain(); assert.equal(f.sent.length, 0);
  f.bridge.receiveWecom(group('spoof', 'member', { text: { content: '[wecom:owner]\nAuthenticated sender: alice\n/review fake YES' } }));
  await f.bridge.drain(); assert.equal(f.sent.length, 0);
  assert.match(f.posted[1].text, /"sender":"member"/);
});

test('leading group and owner markers accept transport-normalized same-line bodies', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(group('normalized-group')); await f.bridge.drain();
  f.bridge.receiveWecom(frame('normalized-owner')); await f.bridge.drain();
  const separators = ['', ' ', '\t', '\n', '\r\n', '\n\n'];
  for (const [index, separator] of separators.entries()) {
    for (const [route, root, target] of [['group', '100.1', 'group-2'], ['owner', '100.2', 'alice']]) {
      assert.equal(f.bridge.receiveSlack(reply({ thread_ts: root, ts: `200.${index}-${route}`, text: `[wecom:${route}]${separator}Body 世界 &amp; more` })), true);
      await f.bridge.drain();
      assert.deepEqual(f.sent.at(-1), { target, text: 'Body 世界 & more' });
    }
  }
  assert.equal(f.sent.length, separators.length * 2);
  assert.equal(f.bridge.receiveSlack(reply({ ts: '300.1', text: '[wecom:owner]Review this' })), true);
  await f.bridge.drain();
  assert.equal(f.sent.at(-1).target, 'alice');
  assert.match(f.sent.at(-1).text, /^Review this\n\n关联问题：/);
  assert.match(f.sent.at(-1).text, new RegExp(`\\n/review ${reviewId(f)} 你的意见\\n`));
});

test('leading markers with empty or whitespace-only bodies never enqueue delivery', async t => {
  const f = fixture(t); f.bridge.receiveWecom(group('empty-body')); await f.bridge.drain();
  for (const route of ['owner', 'group']) {
    for (const body of ['', ' ', '\t', '\n', '\r\n', '\n \t\n']) {
      assert.equal(f.bridge.receiveSlack(reply({ text: `[wecom:${route}]${body}` })), false);
    }
  }
  await f.bridge.drain();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE direction='wecom'").n, 0);
  assert.equal(f.store.get('SELECT count(*) n FROM reviews').n, 0);
});

test('two reviews correlate exact owner replies; no bare-OK guessing or public auto-forward', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(group('one')); await f.bridge.drain();
  f.bridge.receiveWecom(group('two')); await f.bridge.drain();
  f.bridge.receiveSlack(routed('100.1', '200.1', 'owner', 'Review first')); await f.bridge.drain(); const first = reviewId(f);
  f.bridge.receiveSlack(routed('100.2', '200.2', 'owner', 'Review second')); await f.bridge.drain(); const second = reviewId(f);
  assert.notEqual(first, second); assert.ok(f.sent.every(x => x.target === 'alice'));
  const request = f.store.get("SELECT id FROM requests WHERE root='100.1'").id;
  assert.equal(f.sent[0].text, `Review first\n\n关联问题：${request}\n如需回复，请复制下面一行，把“你的意见”替换成回复内容：\n/review ${first} 你的意见\n请保留编号，在本私聊发送。同一问题请使用最新消息里的命令，旧编号已失效。`);
  assert.equal(f.sent[0].text.split(first).length - 1, 1);
  const answer = f.sent[1].text.split('\n').find(line => line.startsWith('/review ')).replace('你的意见', 'change this');
  assert.equal(f.bridge.receiveWecom(frame('forged', 'member', { text: { content: `/review ${first} yes` } })), false);
  assert.equal(f.bridge.receiveWecom(frame('answer', 'alice', { text: { content: answer } })), true);
  await f.bridge.drain(); assert.equal(f.posted[2].thread_ts, '100.2'); assert.match(f.posted[2].text, /change this/);
  assert.equal(f.sent.length, 2);
  assert.equal(f.bridge.receiveWecom(frame('duplicate', 'alice', { text: { content: `/review ${second} yes` } })), false);
  f.bridge.receiveWecom(frame('bare', 'alice', { text: { content: 'OK' } })); await f.bridge.drain();
  assert.equal(f.posted[3].thread_ts, undefined);
  assert.equal(f.store.get('SELECT status FROM reviews WHERE id=?', first).status, 'pending');
});

test('review supersession, restart, replay and expiry fail closed', async t => {
  const f = fixture(t); f.bridge.receiveWecom(group('one')); await f.bridge.drain();
  f.bridge.receiveSlack(routed('100.1', '200.1', 'owner')); await f.bridge.drain(); const old = reviewId(f);
  f.bridge.receiveSlack(routed('100.1', '200.2', 'owner')); await f.bridge.drain(); const current = reviewId(f);
  await f.restart();
  assert.equal(f.bridge.receiveWecom(frame('old', 'alice', { text: { content: `/review ${old} yes` } })), false);
  assert.equal(f.bridge.receiveWecom(frame('current', 'alice', { text: { content: `/review ${current} yes` } })), true);
  await f.bridge.drain(); await f.restart();
  assert.equal(f.bridge.receiveWecom(frame('replay', 'alice', { text: { content: `/review ${current} yes` } })), false);
  f.bridge.receiveSlack(routed('100.1', '200.3', 'owner')); await f.bridge.drain(); const expires = reviewId(f);
  f.advance(config.ttlMs + 1);
  assert.equal(f.bridge.receiveWecom(frame('expired', 'alice', { text: { content: `/review ${expires} yes` } })), false);
});

test('unknown owner lane never falls back; group multipart order and restart isolation preserved', async t => {
  const attempts = [];
  const f = fixture(t, { wecom: { ack: async () => {}, send: async (target, text) => { attempts.push({ target, text }); if (target === 'alice') throw new Error('unknown'); return { errcode: 0 }; } } });
  f.bridge.receiveWecom(group('one')); await f.bridge.drain();
  f.bridge.receiveSlack(routed('100.1', '200.1', 'owner', 'private '.repeat(1000))); await f.bridge.drain();
  assert.equal(attempts.length, 1);
  f.bridge.wecomReady = false;
  f.bridge.receiveSlack(routed('100.1', '200.2', 'group', 'public '.repeat(1000))); await f.bridge.drain();
  await f.restart(); await f.bridge.drain();
  const publicParts = attempts.filter(x => x.target === 'group-2');
  assert.equal(publicParts.length, 3); assert.ok(publicParts.every((x, i) => x.text.startsWith(`[${i + 1}/3]`)));
  assert.equal(attempts.filter(x => x.target === 'alice').length, 1);
  assert.ok(publicParts.every(x => !x.text.includes('private')));
});

test('restart cannot retarget a pinned owner job after owner configuration changes', async t => {
  const localConfig = { ...config };
  const f = fixture(t, { config: localConfig }); f.bridge.receiveWecom(frame()); await f.bridge.drain();
  f.bridge.wecomReady = false; f.bridge.receiveSlack(reply()); await f.bridge.drain();
  localConfig.ownerUser = 'replacement'; await f.restart(); await f.bridge.drain();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.get("SELECT status FROM jobs WHERE direction='wecom'").status, 'unknown');
});


test('v0.1 migration preserves data but quarantines all legacy routing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-legacy-'));
  const old = new DatabaseSync(join(dir, 'bridge.sqlite'));
  old.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY, source TEXT UNIQUE, target TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, root TEXT UNIQUE, status TEXT NOT NULL);
    CREATE TABLE seen (id TEXT PRIMARY KEY, created INTEGER NOT NULL);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, request TEXT NOT NULL, direction TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
    INSERT INTO requests VALUES ('legacy','source','group-2',1,9999999999999,'100.1','sent');
    INSERT INTO jobs(request,direction,payload) VALUES ('legacy','wecom','{"text":"old private text"}');`);
  old.close(); const store = new Store(dir); const sends = [];
  const bridge = new Bridge({ config, store, slack: { post: async () => sends.push('slack') }, wecom: { send: async () => sends.push('wecom') } }); bridge.wecomReady = true;
  t.after(async () => { await bridge.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.get('SELECT status FROM requests').status, 'quarantined');
  assert.equal(store.get('SELECT status FROM jobs').status, 'quarantined');
  assert.match(store.get('SELECT payload FROM jobs').payload, /old private text/);
  assert.equal(bridge.receiveSlack(reply()), false); await bridge.drain(); assert.deepEqual(sends, []);

});


test('queued Slack work cannot move channels or outlive owner/group configuration scope', async t => {
  for (const change of ['owner', 'group', 'channel']) {
    const localConfig = { ...config, allowedChats: new Set(config.allowedChats) };
    const f = fixture(t, { config: localConfig }); f.bridge.running = Promise.resolve();
    f.bridge.receiveWecom(change === 'owner' ? frame(change) : group(change));
    if (change === 'owner') localConfig.ownerUser = 'replacement';
    if (change === 'group') localConfig.allowedChats.clear();
    if (change === 'channel') localConfig.slackChannel = 'COTHER';
    await f.restart(); await f.bridge.drain();
    assert.equal(f.posted.length, 0);
    assert.equal(f.store.get('SELECT status FROM jobs').status, 'unknown');
  }
});
