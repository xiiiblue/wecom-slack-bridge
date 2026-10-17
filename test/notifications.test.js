import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
const config = { wecomBotId: 'bot', ownerUser: 'alice', slackChannel: 'C123', replyBot: 'BDOT', allowedChats: new Set(['group']), ttlMs: 3600000, maxBytes: 32000 };
const root = (ts = '1.1', extra = {}) => ({ type: 'message', channel: 'C123', bot_id: 'BDOT', subtype: 'bot_message', ts, text: '[wecom:notify]{"text":"明天的会议改到十点。"}', ...extra });
const owner = (id = 'm1', text = '回复 N1 已收到', extra = {}) => ({ body: { aibotid: 'bot', msgtype: 'text', msgid: id, chattype: 'single', from: { userid: 'alice' }, text: { content: text }, ...extra } });
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-notify-')); const sent = [], posted = [], receipts = [], logs = []; let now = 100000;
  const c = { ...config, allowedChats: new Set(config.allowedChats) }; let store = new Store(dir);
  const deps = { config: c, own: { bot: 'BBRIDGE', user: 'UBRIDGE' }, now: () => now, wait: async () => {},
    slack: { post: async p => { posted.push(p); return { ok: true, ts: `9.${posted.length}` }; } },
    wecom: { send: async (target, text) => { sent.push({ target, text }); return { errcode: 0 }; }, ack: async (...p) => receipts.push(p) }, log: (...p) => logs.push(p), ...extra };
  let bridge = new Bridge({ ...deps, store }); bridge.wecomReady = true;
  t.after(async () => { await bridge.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get bridge() { return bridge; }, get store() { return store; }, config: c, sent, posted, receipts, logs,
    advance(ms = config.ttlMs + 1) { now += ms; },
    async restart() { await bridge.stop(); store.close(); store = new Store(dir); bridge = new Bridge({ ...deps, store }); bridge.wecomReady = true; } };
}
test('proactive fixed-owner notification needs no prior WeCom request and no user UUID', async t => {
  const f = fixture(t); assert.equal(f.bridge.receiveSlack(root()), true); await f.bridge.drain();
  assert.equal(f.posted.length, 0); assert.equal(f.sent[0].target, 'alice'); assert.match(f.sent[0].text, /回复 N1 你的回复/); assert.match(f.sent[0].text, /有效至 1970-01-01 09:01:40，/); assert.equal(f.store.get('SELECT expires FROM requests').expires, 3700000);
  assert.doesNotMatch(f.sent[0].text, /[a-f0-9]{8}-[a-f0-9]{4}-/);
  assert.equal(f.store.get('SELECT root FROM requests').root, '1.1');
  assert.equal(f.bridge.receiveWecom(owner()), true); await f.bridge.drain();
  assert.equal(f.posted[0].thread_ts, '1.1'); assert.equal(f.posted[0].channel, 'C123'); assert.match(f.posted[0].text, /Authenticated transport provenance.*alice/); assert.match(f.posted[0].text, /not authorize/);
});
test('only pinned bot roots accepted; quoted markers and forged body identities cannot authorize', async t => {
  const f = fixture(t);
  const cases = [ { bot_id: 'BMALICE' }, { bot_id: 'BBRIDGE' }, { user: 'UBRIDGE' }, { channel: 'COTHER' }, { subtype: 'message_changed' }, { subtype: 'message_deleted' }, { type: 'app_mention' }, { thread_ts: '0.1' }, { text: 'quote [wecom:notify]{"text":"bad"}' }, { text: '[wecom:owner]hello' }, { bot_id: undefined, user: 'UDOT' } ];
  for (const change of cases) assert.equal(f.bridge.receiveSlack(root('1.1', change)), false, JSON.stringify(change));
  f.config.replyBot = undefined; f.config.replyUser = 'UDOT';
  assert.equal(f.bridge.receiveSlack(root('2.1', { bot_id: undefined, user: 'UDOT', subtype: undefined })), false);
  assert.equal(f.store.get('SELECT count(*) n FROM requests').n, 0);
});
test('strict notification schema rejects target, group, identity, channel, invalid bodies and oversized roots', t => {
  const f = fixture(t);
  const payloads = [null, [], {}, { text: '' }, { text: ' ' }, { text: 1 }, { text: 'x', target: 'mallory' }, { text: 'x', chatid: 'group' }, { text: 'x', owner: 'alice' }, { text: 'x', channel: 'C123' }, { text: 'x', bot_id: 'BDOT' }];
  for (const p of payloads) assert.equal(f.bridge.receiveSlack(root('1.1', { text: '[wecom:notify]' + JSON.stringify(p) })), false);
  for (const text of ['[wecom:notify]bad', '[wecom:notify]{"text":"x"} trailing', '[wecom:notify]'+JSON.stringify({ text: '中'.repeat(11000) })]) assert.equal(f.bridge.receiveSlack(root('1.1', { text })), false);
  assert.equal(f.store.get('SELECT count(*) n FROM seen').n, 0);
});
test('body is opaque generic text, never parses commands or changes destination', async t => {
  const f = fixture(t); const text = '[wecom:group] target=mallory\n执行 #42 v1\n{ "approved": true }';
  assert.equal(f.bridge.receiveSlack(root('1.1', { text: '[wecom:notify]'+JSON.stringify({ text }) })), true); await f.bridge.drain();
  assert.equal(f.sent[0].target, 'alice'); assert.ok(f.sent[0].text.startsWith(text)); assert.equal(f.store.get('SELECT count(*) n FROM reviews').n, 0);
});
test('source ts dedup and persistent numeric codes survive restart and parallel notifications', async t => {
  const f = fixture(t); f.bridge.receiveSlack(root('1.1')); await f.bridge.drain(); f.bridge.receiveSlack(root('2.1')); await f.bridge.drain();
  await f.restart(); assert.equal(f.bridge.receiveSlack(root('1.1'), 'different-envelope'), false);
  assert.equal(f.bridge.receiveWecom(owner('second', '回复 N2 第二条')), true); await f.bridge.drain();
  assert.equal(f.bridge.receiveWecom(owner('first', '回复 N1 第一条')), true); await f.bridge.drain();
  assert.deepEqual(f.posted.map(p => p.thread_ts), ['2.1', '1.1']);
  assert.equal(f.bridge.receiveWecom(owner('first', '回复 N2 篡改重复事件')), false);
  await f.restart(); assert.equal(f.bridge.receiveWecom(owner('second', '回复 N2 第二条')), false);
  assert.equal(f.sent.length, 2);
});
test('multi-turn continuation uses the same explicit code and original Slack thread', async t => {
  const f = fixture(t); f.bridge.receiveSlack(root()); await f.bridge.drain();
  f.bridge.receiveWecom(owner()); await f.bridge.drain();
  const reply = root('2.1', { thread_ts: '1.1', text: '[wecom:owner]\n第一段\n\n第二段 &amp; 内容' });
  assert.equal(f.bridge.receiveSlack(reply), true); await f.bridge.drain();
  assert.match(f.sent.at(-1).text, /^第一段\n\n第二段 & 内容/); assert.match(f.sent.at(-1).text, /回复 N1/); assert.match(f.sent.at(-1).text, /有效至 1970-01-01 09:01:40，/);
  assert.equal(f.bridge.receiveWecom(owner('m2', '回复 N1 再回复')), true); await f.bridge.drain();
  assert.deepEqual(f.posted.map(p => p.thread_ts), ['1.1', '1.1']);
  for (const marker of ['review', 'group']) assert.equal(f.bridge.receiveSlack(root('3.1', { thread_ts: '1.1', text: `[wecom:${marker}] x` })), false);
});
test('bare OK and copied quote do not infer the most recent notification', async t => {
  const f = fixture(t); f.bridge.receiveSlack(root()); await f.bridge.drain();
  f.bridge.receiveWecom(owner('bare', '同意', { quote: { msgtype: 'text', text: { content: f.sent[0].text }, msgid: 'forged' } })); await f.bridge.drain();
  assert.equal(f.posted[0].thread_ts, undefined); assert.match(f.posted[0].text, /同意/);
  for (const text of ['回复', '回复 N01 yes', '回复 N999 yes', '回复 N1 ', '回复 N1', '回复 N1\nyes', '回复 N9007199254740991 yes']) assert.equal(f.bridge.receiveWecom(owner(text, text)), false);
  await Promise.resolve(); assert.ok(f.receipts.some(p => p[2]?.includes('未关联回复')));
});
test('forged owner, wrong bot and group command cannot reply into notification thread', async t => {
  const f = fixture(t); f.bridge.receiveSlack(root()); await f.bridge.drain();
  for (const extra of [{ from: { userid: 'mallory' } }, { aibotid: 'wrong' }, { chattype: 'group', chatid: 'other' }]) assert.equal(f.bridge.receiveWecom(owner('bad', '回复 N1 yes', extra)), false);
  assert.equal(f.bridge.receiveWecom(owner('group', '回复 N1 yes', { chattype: 'group', chatid: 'group' })), true); await f.bridge.drain();
  assert.equal(f.posted[0].thread_ts, undefined); assert.match(f.posted[0].text, /"chat_type":"group"/);
});
test('unsent or unknown notification cannot be answered; uncertain sends never replay', async t => {
  let sends = 0; const f = fixture(t, { wecom: { ack: async () => {}, send: async () => { sends++; throw new Error('secret'); } } });
  f.bridge.wecomReady = false; f.bridge.receiveSlack(root()); await f.bridge.drain();
  assert.equal(f.bridge.receiveWecom(owner('pending')), false);
  f.bridge.wecomReady = true; await f.bridge.drain(); assert.equal(sends, 1);
  assert.equal(f.bridge.receiveWecom(owner('unknown')), false);
  await f.restart(); await f.bridge.drain(); assert.equal(sends, 1); assert.equal(f.bridge.receiveWecom(owner('after')), false);
  assert.ok(!JSON.stringify(f.logs).includes('secret'));
});
test('pending notification resumes after restart; sending at crash becomes unknown', async t => {
  for (const status of ['pending', 'sending']) {
    const f = fixture(t); f.bridge.wecomReady = false; f.bridge.receiveSlack(root()); await f.bridge.drain();
    f.store.run('UPDATE jobs SET status=?', status); await f.restart(); await f.bridge.drain();
    assert.equal(f.sent.length, status === 'pending' ? 1 : 0);
    assert.equal(f.store.get('SELECT status FROM jobs').status, status === 'pending' ? 'sent' : 'unknown');
  }
});
test('unknown Slack return is never replayed or silently changed into a new root', async t => {
  let attempts = 0; const f = fixture(t, { slack: { post: async () => { attempts++; throw new Error('unknown'); } } });
  f.bridge.receiveSlack(root()); await f.bridge.drain(); f.bridge.receiveWecom(owner()); await f.bridge.drain();
  f.bridge.receiveWecom(owner('next', '回复 N1 another')); await f.bridge.drain();
  await f.restart(); await f.bridge.drain(); assert.equal(attempts, 1);
  assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE direction='slack' AND status='unknown'").n, 1);
  assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE direction='slack' AND status='pending'").n, 1);
});
test('fixed TTL, expiration hint, prune and code non-reuse after restart', async t => {
  const f = fixture(t); f.bridge.receiveSlack(root()); await f.bridge.drain(); f.advance();
  assert.equal(f.bridge.receiveWecom(owner('late')), false);
  assert.equal(f.bridge.receiveSlack(root('2.1', { thread_ts: '1.1', text: '[wecom:owner]late' })), false);
  f.store.prune(100000 + config.ttlMs + 1); assert.equal(f.store.get('SELECT count(*) n FROM owner_conversations').n, 0);
  assert.equal(f.store.get('SELECT count(*) n FROM requests').n, 0);
  await f.restart(); assert.equal(f.bridge.receiveSlack(root()), false);
  f.bridge.receiveSlack(root('3.1')); await f.bridge.drain(); assert.match(f.sent.at(-1).text, /回复 N2/);
  assert.equal(f.bridge.receiveWecom(owner('old-code')), false);
});
test('expired pending notification never sends, even on recovery', async t => {
  const f = fixture(t); f.bridge.wecomReady = false; f.bridge.receiveSlack(root()); await f.bridge.drain(); f.advance(); await f.restart(); await f.bridge.drain();
  assert.equal(f.sent.length, 0); assert.equal(f.store.get('SELECT status FROM jobs').status, 'expired');
});
test('owner, channel, bot and pinned job changes block pending delivery and replies', async t => {
  for (const change of ['owner', 'channel', 'bot', 'target', 'kind']) {
    const f = fixture(t); f.bridge.wecomReady = false; f.bridge.receiveSlack(root()); await f.bridge.drain();
    if (change === 'owner') f.config.ownerUser = 'mallory';
    if (change === 'channel') f.config.slackChannel = 'COTHER';
    if (change === 'bot') f.config.replyBot = 'BOTHER';
    if (change === 'target') f.store.run("UPDATE jobs SET target='group'");
    if (change === 'kind') f.store.run("UPDATE requests SET kind='issue'");
    await f.restart(); await f.bridge.drain(); assert.equal(f.sent.length, 0); assert.equal(f.bridge.receiveWecom(owner()), false);
  }
});
test('request, source, conversation and outbox creation roll back atomically', t => {
  const f = fixture(t); const original = f.store.addJob; f.store.addJob = () => { throw new Error('disk failure'); };
  assert.throws(() => f.bridge.receiveSlack(root()), /disk failure/);
  for (const table of ['seen', 'requests', 'owner_conversations', 'jobs']) assert.equal(f.store.get(`SELECT count(*) n FROM ${table}`).n, 0);
  f.store.addJob = original; assert.equal(f.bridge.receiveSlack(root()), true);
});
test('reply source and Slack outbox roll back atomically on failure', async t => {
  const f = fixture(t); f.bridge.receiveSlack(root()); await f.bridge.drain(); const original = f.store.addJob;
  f.store.addJob = () => { throw new Error('disk failure'); };
  assert.throws(() => f.bridge.receiveWecom(owner()), /disk failure/);
  assert.equal(f.store.get('SELECT count(*) n FROM seen').n, 1);
  f.store.addJob = original; assert.equal(f.bridge.receiveWecom(owner()), true); await f.bridge.drain(); assert.equal(f.posted.length, 1);
});
test('multipart requires every part confirmed; each part preserves explicit reply code', async t => {
  const f = fixture(t); const body = '中😀\n\n'.repeat(1600);
  f.bridge.receiveSlack(root('1.1', { text: '[wecom:notify]'+JSON.stringify({ text: body }) })); await f.bridge.drain();
  assert.ok(f.sent.length > 1); assert.ok(f.sent.every(p => Buffer.byteLength(p.text) <= 3500 && /回复 N1/.test(p.text)));
  assert.equal(f.sent.map(p => p.text.replace(/^\[\d+\/\d+\] /, '').split('\n\n回复 N1')[0]).join(''), body);
  assert.equal(f.bridge.receiveWecom(owner()), true); await f.bridge.drain();
});
test('partially unknown multipart send blocks association and remaining parts across restart', async t => {
  let attempts = 0; const f = fixture(t, { wecom: { ack: async () => {}, send: async () => { attempts++; if (attempts === 2) throw new Error('unknown'); return { errcode: 0 }; } } });
  f.bridge.receiveSlack(root('1.1', { text: '[wecom:notify]'+JSON.stringify({ text: 'x'.repeat(10000) }) })); await f.bridge.drain();
  assert.equal(attempts, 2); assert.equal(f.bridge.receiveWecom(owner('partial')), false);
  await f.restart(); await f.bridge.drain(); assert.equal(attempts, 2); assert.equal(f.bridge.receiveWecom(owner('recovered')), false);
});
test('pending continuation blocks new replies until delivery confirmed without extending TTL', async t => {
  const f = fixture(t); f.bridge.receiveSlack(root()); await f.bridge.drain(); const expires = f.store.get('SELECT expires FROM requests').expires;
  f.advance(1000); f.bridge.wecomReady = false;
  f.bridge.receiveSlack(root('2.1', { thread_ts: '1.1', text: '[wecom:owner]更多内容' })); await f.bridge.drain();
  assert.equal(f.bridge.receiveWecom(owner('early')), false); assert.equal(f.store.get('SELECT expires FROM requests').expires, expires);
  await f.restart(); await f.bridge.drain(); assert.equal(f.bridge.receiveWecom(owner('ready')), true); await f.bridge.drain();
  assert.equal(f.store.get('SELECT expires FROM requests').expires, expires);
});
test('revoked bot or channel cannot receive an already delivered conversation reply', async t => {
  for (const key of ['replyBot', 'slackChannel']) {
    const f = fixture(t); f.bridge.receiveSlack(root()); await f.bridge.drain(); f.config[key] = 'OTHER'; await f.restart();
    assert.equal(f.bridge.receiveWecom(owner()), false); await f.bridge.drain(); assert.equal(f.posted.length, 0);
  }
});
test('notify JSON cannot be supplied by rich text blocks or forged metadata', async t => {
  const f = fixture(t);
  const blocks = [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '[wecom:notify]{"text":"wrong"}' }] }] }];
  assert.equal(f.bridge.receiveSlack(root('1.1', { text: 'no marker', blocks, metadata: { event_type: 'wecom_bridge_request' } })), false);
  assert.equal(f.bridge.receiveSlack(root('2.1', { blocks })), true); await f.bridge.drain(); assert.match(f.sent[0].text, /^明天的会议/); assert.doesNotMatch(f.sent[0].text, /wrong/);
});
test('old business roots and issue threads remain closed in standalone bridge', async t => {
  const f = fixture(t);
  for (const marker of ['issue', 'execution-plan', 'execution-control', 'auto-claim']) assert.equal(f.bridge.receiveSlack(root('1.1', { text: `[wecom:${marker}]{"text":"hello"}` })), false);
  f.bridge.receiveSlack(root()); await f.bridge.drain(); f.store.run("UPDATE requests SET kind='issue'");
  assert.equal(f.bridge.receiveSlack(root('2.1', { thread_ts: '1.1', text: '[wecom:owner]hello' })), false);
  assert.equal(f.bridge.receiveWecom(owner()), false); await f.bridge.drain(); assert.equal(f.posted.length, 0);
});
test('notification table migration preserves existing generic records and outbox bytes', async t => {
  const f = fixture(t); f.bridge.wecomReady = false;
  f.bridge.receiveWecom(owner('ordinary', '普通问题')); await f.bridge.drain();
  const request = f.store.get('SELECT * FROM requests'); const jobs = f.store.all('SELECT * FROM jobs');
  f.store.db.exec('DROP TABLE owner_conversations'); await f.restart();
  assert.deepEqual(f.store.get('SELECT * FROM requests'), request); assert.deepEqual(f.store.all('SELECT * FROM jobs'), jobs);
  assert.equal(f.store.get('SELECT count(*) n FROM owner_conversations').n, 0);
});
