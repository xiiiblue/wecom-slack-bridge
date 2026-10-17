import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Bridge, allowedReply } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { chunks } from '../src/text.js';

const config = { wecomBotId: 'test-bot', allowedUsers: new Set(['alice']), allowedChats: new Set(), slackChannel: 'C123', replyBot: 'BDOT', ttlMs: 3600000, maxBytes: 32000 };
const frame = (id = 'm1', user = 'alice', extra = {}) => ({ headers: { req_id: `r-${id}` }, body: { aibotid: 'test-bot', msgid: id, msgtype: 'text', chattype: 'single', from: { userid: user }, text: { content: 'Hello 世界 😀' }, ...extra } });
const reply = (extra = {}) => ({ type: 'message', channel: 'C123', thread_ts: '100.1', ts: '100.2', subtype: 'bot_message', bot_id: 'BDOT', text: 'Reply 世界 😀', ...extra });
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
  f.bridge.receiveSlack(reply({ thread_ts: '100.2', ts: '200.2' })); await f.bridge.drain();
  f.bridge.receiveSlack(reply({ thread_ts: '100.1', ts: '200.1' })); await f.bridge.drain();
  assert.deepEqual(f.sent.map(x => x.target), ['group-2', 'alice']);
});

test('dedup survives restart; changing event envelope does not duplicate Slack delivery', async t => {
  const f = fixture(t); f.bridge.receiveWecom(frame()); await f.bridge.drain();
  f.bridge.receiveSlack(reply(), 'Ev1'); await f.bridge.drain(); await f.restart();
  assert.equal(f.bridge.receiveWecom(frame()), false);
  assert.equal(f.bridge.receiveSlack(reply(), 'EvDifferent'), false);
  await f.bridge.drain(); assert.equal(f.posted.length, 1); assert.equal(f.sent.length, 1);
  f.bridge.receiveSlack(reply({ ts: '100.3', text: 'Later response' }), 'Ev2'); await f.bridge.drain();
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
  f.bridge.receiveSlack(reply({ text: '😀'.repeat(3000) })); await f.bridge.drain();
  assert.ok(f.sent.length > 1); assert.ok(f.sent.every(x => Buffer.byteLength(x.text) <= 3500));
});

test('one active process per state directory', t => {
  const f = fixture(t); assert.throws(() => new Store(f.dir), /locked/);
});

test('required configuration is strict', () => {
  const env = { WECOM_BOT_ID: 'bot', WECOM_BOT_SECRET: 'placeholder', WECOM_ALLOWED_USER_IDS: 'alice', SLACK_BOT_TOKEN: 'placeholder', SLACK_APP_TOKEN: 'placeholder', SLACK_CHANNEL_ID: 'C123', SLACK_REPLY_BOT_ID: 'B123' };
  assert.equal(loadConfig(env).ttlMs, 3600000);
  assert.throws(() => loadConfig({ ...env, WECOM_ALLOWED_USER_IDS: '' }));
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

test('optional chat allowlist applies to both single and group destinations', async t => {
  const f = fixture(t, { config: { ...config, allowedChats: new Set(['allowed-group']) } });
  assert.equal(f.bridge.receiveWecom(frame('single')), false);
  assert.equal(f.bridge.receiveWecom(frame('group-no', 'alice', { chattype: 'group', chatid: 'other' })), false);
  assert.equal(f.bridge.receiveWecom(frame('group-yes', 'alice', { chattype: 'group', chatid: 'allowed-group' })), true);
  await f.bridge.drain(); assert.equal(f.posted.length, 1);
});

test('disconnected WeCom defers replies; TTL expires queued work without sending', async t => {
  const f = fixture(t); f.bridge.receiveWecom(frame()); await f.bridge.drain();
  f.bridge.wecomReady = false; f.bridge.receiveSlack(reply()); await f.bridge.drain();
  assert.equal(f.sent.length, 0); assert.equal(f.store.get("SELECT status FROM jobs WHERE direction='wecom'").status, 'pending');
  f.advance(config.ttlMs + 1); f.bridge.wecomReady = true; await f.bridge.drain();
  assert.equal(f.sent.length, 0); assert.equal(f.store.get("SELECT status FROM jobs WHERE direction='wecom'").status, 'expired');
});
