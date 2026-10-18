import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { createStreamDemo } from '../src/stream-demo.js';

const initial = Date.UTC(2026, 9, 18, 5);
const config = { wecomBotId: 'test-bot', ownerUser: 'owner', allowedChats: new Set(['test-group']), slackChannel: 'C123', replyBot: 'BREPLY', ttlMs: 3600000, maxBytes: 32000 };
const phrase = 'stream-demo-synthetic-123';
const env = { WECOM_STREAM_DEMO_PHRASE: phrase, WECOM_STREAM_DEMO_STARTS_AT: new Date(initial - 1000).toISOString(), WECOM_STREAM_DEMO_EXPIRES_AT: new Date(initial + 600000).toISOString() };
const frame = (id = 'new-message', extra = {}) => ({ headers: { req_id: 'real-callback-request' }, body: { aibotid: config.wecomBotId, msgid: id, msgtype: 'text', chattype: 'group', chatid: 'test-group', from: { userid: 'owner' }, create_time: initial / 1000, text: { content: phrase }, ...extra } });

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stream-demo-test-'));
  let store = new Store(dir), time = initial, demo;
  const streams = [], posts = [], acks = [], sends = [], logs = [], waits = [];
  const options = { env, config, now: () => time, wait: async ms => { waits.push(ms); }, log: event => logs.push(event), replyStream: async (...args) => { streams.push(args); return { errcode: 0 }; }, ...overrides };
  const makeDemo = () => createStreamDemo({ ...options, store });
  demo = makeDemo();
  const bridge = new Bridge({ config, store, streamDemo: demo, wait: async () => {}, now: () => time,
    slack: { post: async p => { posts.push(p); return { ok: true, ts: `100.${posts.length}` }; } },
    wecom: { ack: async (...args) => acks.push(args), send: async (...args) => { sends.push(args); return { errcode: 0 }; } } });
  bridge.wecomReady = true;
  t.after(async () => { await demo?.stop(); await bridge.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { bridge, get demo() { return demo; }, get store() { return store; }, streams, posts, acks, sends, logs, waits,
    advance(ms) { time += ms; }, async restartDemo() { await demo.stop(); store.close(); store = new Store(dir); demo = makeDemo(); } };
}

test('demo is disabled by default; partial, unbounded and multiple-group configurations fail closed', () => {
  assert.equal(createStreamDemo({ env: {}, config }), null);
  for (const demoEnv of [{ WECOM_STREAM_DEMO_PHRASE: phrase }, { ...env, WECOM_STREAM_DEMO_STARTS_AT: 'bad' }, { ...env, WECOM_STREAM_DEMO_EXPIRES_AT: new Date(initial + 31 * 60000).toISOString() }, { ...env, WECOM_STREAM_DEMO_PHRASE: phrase + '\n' }]) {
    assert.throws(() => createStreamDemo({ env: demoEnv, config }));
  }
  assert.throws(() => createStreamDemo({ env, config: { ...config, allowedChats: new Set(['a', 'b']) } }));
  for (const name of ['', '@Test Bot', 'Test Bot\n', ' Test Bot']) assert.throws(() => createStreamDemo({ env: { ...env, WECOM_STREAM_DEMO_MENTION_NAME: name }, config }));
});

test('fresh matching callback updates the same stream and request, exclusively without normal ack or Slack', async t => {
  const f = fixture(t);
  assert.equal(f.bridge.receiveWecom(frame()), true);
  await f.demo.drain(); await f.bridge.drain();
  assert.equal(f.streams.length, 2);
  assert.deepEqual(f.streams.map(x => x[0]), [{ headers: { req_id: 'real-callback-request' } }, { headers: { req_id: 'real-callback-request' } }]);
  assert.equal(f.streams[0][1], f.streams[1][1]);
  assert.deepEqual(f.streams.map(x => x[3]), [false, true]);
  assert.deepEqual(f.waits, [2500]);
  assert.match(f.streams[1][2], /最终测试答案/);
  assert.deepEqual([f.acks.length, f.posts.length, f.sends.length], [0, 0, 0]);
  assert.equal(f.store.get('SELECT count(*) n FROM requests').n, 0);
  assert.deepEqual(f.logs, ['stream_demo_claimed', 'stream_demo_started', 'stream_demo_finished']);
});

test('exact group, original owner and bot are required; other traffic retains ordinary routing', async t => {
  const f = fixture(t);
  for (const extra of [{ aibotid: 'other' }, { chatid: 'other' }, { from: { userid: 'member' } }, { chattype: 'single' }, { msgtype: 'image' }, { text: { content: phrase + ' extra' } }]) {
    assert.equal(f.demo.receive(frame('different', extra)), false);
  }
  assert.equal(f.bridge.receiveWecom(frame('regular', { text: { content: 'ordinary group question' } })), true);
  await f.bridge.drain(); await Promise.resolve();
  assert.equal(f.posts.length, 1); assert.equal(f.acks.length, 1); assert.equal(f.streams.length, 0);
});

test('duplicate and second fresh callback cannot consume the demonstration twice, including after restart', async t => {
  const f = fixture(t);
  f.demo.receive(frame()); f.demo.receive(frame()); f.demo.receive(frame('second'));
  await f.demo.drain(); assert.equal(f.streams.length, 2);
  await f.restartDemo();
  assert.equal(f.demo.receive(frame('third')), true); await f.demo.drain();
  assert.equal(f.streams.length, 2);
});

test('configured bot mention plus exact phrase is exclusive; other names and quoted prefixes do not match', async t => {
  const f = fixture(t, { env: { ...env, WECOM_STREAM_DEMO_MENTION_NAME: 'Test Assistant' } });
  for (const content of [`@Other ${phrase}`, `quote @Test Assistant ${phrase}`, `@Test Assistant  ${phrase}`, `@Test Assistant ${phrase} extra`]) {
    assert.equal(f.demo.receive(frame('wrong-prefix', { text: { content } })), false);
  }
  const message = frame('with-mention', { text: { content: `@Test Assistant ${phrase}` } });
  assert.equal(f.demo.receive({ ...message, body: { ...message.body, from: { userid: 'other-member' } } }), false);
  assert.equal(f.bridge.receiveWecom(message), true); await f.demo.drain(); await f.bridge.drain();
  assert.equal(f.streams.length, 2);
  assert.deepEqual([f.acks.length, f.posts.length], [0, 0]);
  assert.deepEqual(f.streams.map(x => x[3]), [false, true]);
});

test('adding the mention matcher cannot replay a previously normally forwarded callback', async t => {
  const f = fixture(t);
  const message = frame('old-prefix', { text: { content: `@Test Assistant ${phrase}` } });
  f.bridge.receiveWecom(message); await f.bridge.drain(); assert.equal(f.posts.length, 1);
  const repaired = createStreamDemo({ env: { ...env, WECOM_STREAM_DEMO_MENTION_NAME: 'Test Assistant' }, config, store: f.store, now: () => initial, wait: async () => {}, replyStream: async () => { assert.fail('old event replayed'); } });
  assert.equal(repaired.receive(message), true); await repaired.drain(); await repaired.stop();
  assert.equal(f.store.get("SELECT count(*) n FROM seen WHERE id LIKE 'stream-demo:%'").n, 0);
});

test('old, future, missing timestamp and missing real request id callbacks do not claim or send', async t => {
  const f = fixture(t);
  for (const extra of [{ create_time: initial / 1000 - 2 }, { create_time: initial / 1000 + 31 }, { create_time: undefined }]) assert.equal(f.demo.receive(frame('invalid', extra)), true);
  for (const headers of [{}, { req_id: '' }]) assert.equal(f.demo.receive({ ...frame(), headers }), true);
  assert.equal(f.streams.length, 0); assert.equal(f.store.get('SELECT count(*) n FROM seen').n, 0);
  f.demo.receive(frame()); await f.demo.drain(); assert.equal(f.streams.length, 2);
});

test('previously seen inbound message cannot be replayed as a demo', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(frame('seen', { text: { content: 'previous ordinary text' } })); await f.bridge.drain();
  f.demo.receive(frame('seen')); await f.demo.drain(); assert.equal(f.streams.length, 0);
});

test('hard expiry suppresses reserved text without normal forwarding', async t => {
  const f = fixture(t); f.advance(600000);
  f.bridge.receiveWecom(frame()); await f.bridge.drain();
  assert.deepEqual([f.streams.length, f.posts.length, f.acks.length], [0, 0, 0]);
});

test('expiry between updates prevents a late final send and consumes the attempt', async t => {
  let f; f = fixture(t, { wait: async () => f.advance(600000) });
  f.demo.receive(frame()); await f.demo.drain();
  assert.equal(f.streams.length, 1); assert.ok(f.logs.includes('stream_demo_interrupted'));
});

test('stop during the pause prevents final send', async t => {
  let release; const pause = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { wait: () => pause });
  f.demo.receive(frame()); await Promise.resolve();
  const stopped = f.demo.stop(); release(); await stopped;
  assert.equal(f.streams.length, 1); assert.ok(f.logs.includes('stream_demo_interrupted'));
});

for (const failureAt of [1, 2]) {
  test(`unknown send at stage ${failureAt} is consumed across restart, with no fallback or retry`, async t => {
    let attempts = 0;
    const f = fixture(t, { replyStream: async () => { attempts++; if (attempts === failureAt) throw new Error('network result unknown'); return { errcode: 0 }; } });
    f.demo.receive(frame()); await f.demo.drain(); assert.equal(attempts, failureAt);
    assert.ok(f.logs.includes('stream_demo_unknown'));
    await f.restartDemo(); f.demo.receive(frame('again')); await f.demo.drain();
    assert.equal(attempts, failureAt); assert.equal(f.sends.length, 0);
  });
}

test('negative acknowledgment stops after first attempt without disclosing its payload', async t => {
  let attempts = 0;
  const f = fixture(t, { replyStream: async () => { attempts++; return { errcode: 1, errmsg: 'sensitive diagnostic' }; } });
  f.demo.receive(frame()); await f.demo.drain();
  assert.equal(attempts, 1); assert.ok(f.logs.includes('stream_demo_unknown'));
  assert.ok(!JSON.stringify(f.logs).includes('sensitive'));
});
