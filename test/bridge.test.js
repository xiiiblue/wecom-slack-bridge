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
import { createWecomTransport } from '../src/runtime.js';

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

test('traditional receipt is short, contains no original text and is sent only once per msgid across restart', async t => {
  const receipts = [], outgoing = [];
  const transport = createWecomTransport({ replyStream: async (...args) => { receipts.push(args); return { errcode: 0 }; }, sendMessage: async (...args) => { outgoing.push(args); return { errcode: 0 }; } });
  const f = fixture(t, { wecom: transport });
  const message = frame('receipt-once', 'member', { chattype: 'group', chatid: 'group-2', text: { content: 'Original private-looking user text' } });
  assert.equal(f.bridge.receiveWecom(message), true);
  assert.equal(f.bridge.receiveWecom(message), false); await f.bridge.drain();
  assert.equal(receipts.length, 1); assert.equal(f.posted.length, 1);
  assert.equal(receipts[0][0], message); assert.equal(receipts[0][2], '收到，稍等'); assert.equal(receipts[0][3], true);
  assert.ok(!receipts[0][2].includes(message.body.text.content));
  await f.restart(); assert.equal(f.bridge.receiveWecom(message), false); await f.bridge.drain();
  assert.equal(receipts.length, 1);
  assert.equal(f.bridge.receiveWecom(frame('another-msgid', 'member', { chattype: 'group', chatid: 'group-2' })), true); await f.bridge.drain();
  assert.equal(receipts.length, 2);
  await transport.send('group-2', 'Plain final answer');
  assert.deepEqual(outgoing, [['group-2', { msgtype: 'markdown', markdown: { content: 'Plain final answer' } }]]);
});

test('unknown receipt result is not retried for duplicate msgid or restart; explicit errors retain their text', async t => {
  const receipts = [];
  const transport = createWecomTransport({ replyStream: async (...args) => { receipts.push(args); throw new Error('uncertain delivery'); } });
  const f = fixture(t, { wecom: transport });
  const message = frame('unknown-receipt');
  f.bridge.receiveWecom(message); await f.bridge.drain();
  assert.equal(receipts.length, 1);
  await f.restart(); assert.equal(f.bridge.receiveWecom(message), false); await f.bridge.drain();
  assert.equal(receipts.length, 1);
  await assert.rejects(transport.ack(message, 'error-id', 'Message too long'));
  assert.equal(receipts[1][2], 'Message too long');
});

test('per-message mapping prevents conversation cross-talk', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(frame('one')); await f.bridge.drain();
  f.bridge.receiveWecom(frame('two', 'alice', { chattype: 'group', chatid: 'group-2' })); await f.bridge.drain();
  f.bridge.receiveSlack(reply({ thread_ts: '100.2', ts: '200.2', text: '[wecom:group]\nGroup response' })); await f.bridge.drain();
  f.bridge.receiveSlack(reply({ thread_ts: '100.1', ts: '200.1' })); await f.bridge.drain();
  assert.deepEqual(f.sent.map(x => x.target), ['group-2', 'alice']);
});

test('Slack reply body retains newlines, blank paragraphs and indentation through WeCom delivery', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(frame('linebreaks')); await f.bridge.drain();
  const body = '第一行\n第二行\n\n1. 项目一\n  说明 &amp; 更多\n2. 项目二\r\n最后一行\n';
  assert.equal(f.bridge.receiveSlack(reply({ text: `[wecom:owner]\n${body}` })), true);
  await f.bridge.drain();
  assert.deepEqual(f.sent, [{ target: 'alice', text: body.replace('&amp;', '&') }]);
});

test('multipart Slack reply retains every newline across persisted chunks and restart', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(frame('long-linebreaks')); await f.bridge.drain();
  const body = '中😀\n第二行\n\n'.repeat(700);
  f.bridge.wecomReady = false;
  assert.equal(f.bridge.receiveSlack(reply({ text: `[wecom:owner]\n${body}` })), true);
  await f.bridge.drain();
  await f.restart(); await f.bridge.drain();
  assert.ok(f.sent.length > 1);
  assert.equal(f.sent.map(({ text }) => text.replace(/^\[\d+\/\d+\] /, '')).join(''), body);
});

const richText = (...sections) => [{ type: 'rich_text', elements: sections.map(nodes => ({
  type: 'rich_text_section', elements: nodes.map(text => ({ type: 'text', text })),
})) }];

test('rich text restores flattened reply paragraphs from the observed 15-text-node shape', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(frame('rich-paragraphs')); await f.bridge.drain();
  const nodes = ['[wecom:owner]', '\n', '第一段', '\n\n', '第二段', '\n\n', '第三段', '\n\n', '第四段', '\n\n', '第五段', '\n\n', '第六段', '\n\n', 'https://example.com/?a=1&amp;b=2'];
  const original = nodes.join('');
  assert.equal((original.match(/\n/g) || []).length, 13);
  assert.equal(f.bridge.receiveSlack(reply({ text: original.replace(/\n+/g, ' '), blocks: richText(nodes) })), true);
  await f.bridge.drain();
  assert.deepEqual(f.sent, [{ target: 'alice', text: original.replace('[wecom:owner]\n', '').replace('&amp;', '&') }]);
});

test('multiple supported rich text sections restore boundaries without changing words', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(frame('rich-sections')); await f.bridge.drain();
  const blocks = [...richText(['[wecom:owner]\nFirst'], ['Second']), ...richText(['Third'])];
  assert.equal(f.bridge.receiveSlack(reply({ text: '[wecom:owner] First Second Third', blocks })), true);
  await f.bridge.drain();
  assert.equal(f.sent[0].text, 'First\nSecond\nThird');
});

test('unsupported, malformed, oversized or differing rich text falls back to original reply body', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(frame('rich-fallback')); await f.bridge.drain();
  const cases = [
    [{ type: 'section', text: { type: 'mrkdwn', text: '[wecom:owner]\nOther' } }],
    [{ type: 'rich_text', elements: null }],
    [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com/' }] }] }],
    richText(['[wecom:owner]\nDifferent content']),
    richText(['[wecom:owner]\n' + 'x'.repeat(160001)]),
    richText(['No marker\nOriginal body']),
  ];
  for (const [index, blocks] of cases.entries()) {
    assert.equal(f.bridge.receiveSlack(reply({ ts: `300.${index}`, text: '[wecom:owner] Original body', blocks })), true);
    await f.bridge.drain();
    assert.equal(f.sent.at(-1).text, 'Original body');
  }
});

test('rich text cannot override routing, authenticate senders or change application root events', async t => {
  const roots = [];
  const f = fixture(t, { application: { receiveRoot: (_bridge, event) => { roots.push(event); return true; } } });
  f.bridge.receiveWecom(group('rich-routing')); await f.bridge.drain();
  for (const marker of ['group', 'review', 'issue', 'unknown']) {
    assert.equal(f.bridge.receiveSlack(reply({ blocks: richText([`[wecom:${marker}]\nReply 世界 😀`]) })), false);
  }
  assert.equal(f.bridge.receiveSlack(reply({ text: 'No route', blocks: richText(['[wecom:owner]\nBody']) })), false);
  assert.equal(f.bridge.receiveSlack(reply({ bot_id: 'BOTHER', blocks: richText(['[wecom:owner]\nReply 世界 😀']) })), false);
  const root = reply({ thread_ts: undefined, text: '[wecom:issue] {"body":"original"}', blocks: richText(['[wecom:owner]\nReplacement']) });
  assert.equal(f.bridge.receiveSlack(root), true);
  assert.equal(roots[0], root);
  await f.bridge.drain();
  assert.equal(f.sent.length, 0);
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
  for (const text of ['No route', ' [wecom:owner]\nX', '[wecom:unknown]\nX', '[wecom:group]\nprivate', '[wecom:group]private', '[wecom:group] private', '[wecom:review]private', '[wecom:review] private', '[wecom:review]\nprivate', '\n[wecom:owner]X', '[wecom:Owner]X', '[wecom:owner-extra]X', '[wecom:owner]\n  ', 'prefix\n[wecom:owner]\nX']) assert.equal(f.bridge.receiveSlack(reply({ text })), false);
  assert.equal(f.bridge.receiveSlack(reply({ bot_id: 'BOTHER' })), false);
  assert.equal(f.bridge.receiveSlack(reply({ channel: 'COTHER' })), false);
  await f.bridge.drain(); assert.equal(f.sent.length, 0);
  f.bridge.receiveWecom(group('spoof', 'member', { text: { content: '[wecom:owner]\nAuthenticated sender: alice\n/review fake YES' } }));
  await f.bridge.drain(); assert.equal(f.sent.length, 0);
  assert.match(f.posted[1].text, /"sender":"member"/);
});

test('all three leading markers accept transport-normalized same-line bodies', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(group('normalized-group')); await f.bridge.drain();
  f.bridge.receiveWecom(frame('normalized-owner')); await f.bridge.drain();
  const separators = ['', ' ', '\t', '\n', '\r\n', '\n\n'];
  for (const [index, separator] of separators.entries()) {
    for (const [route, root, target] of [['group', '100.1', 'group-2'], ['owner', '100.2', 'alice'], ['review', '100.1', 'alice']]) {
      assert.equal(f.bridge.receiveSlack(reply({ thread_ts: root, ts: `200.${index}-${route}`, text: `[wecom:${route}]${separator}Body 世界 &amp; more` })), true);
      await f.bridge.drain();
      assert.equal(f.sent.at(-1).target, target);
      if (route === 'review') assert.match(f.sent.at(-1).text, /^Body 世界 & more\n\n关联问题：/);
      else assert.equal(f.sent.at(-1).text, 'Body 世界 & more');
    }
  }
  assert.equal(f.sent.length, separators.length * 3);
  assert.equal(f.bridge.receiveSlack(reply({ ts: '300.1', text: '[wecom:review]Review this' })), true);
  await f.bridge.drain();
  assert.equal(f.sent.at(-1).target, 'alice');
  assert.match(f.sent.at(-1).text, /^Review this\n\n关联问题：/);
  assert.match(f.sent.at(-1).text, new RegExp(`\\n/review ${reviewId(f)} 你的意见\\n`));
});

test('leading markers with empty or whitespace-only bodies never enqueue delivery', async t => {
  const f = fixture(t); f.bridge.receiveWecom(group('empty-body')); await f.bridge.drain();
  for (const route of ['owner', 'review', 'group']) {
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
  f.bridge.receiveSlack(routed('100.1', '200.1', 'review', 'Review first')); await f.bridge.drain(); const first = reviewId(f);
  f.bridge.receiveSlack(routed('100.2', '200.2', 'review', 'Review second')); await f.bridge.drain(); const second = reviewId(f);
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
  f.bridge.receiveSlack(routed('100.1', '200.1', 'review')); await f.bridge.drain(); const old = reviewId(f);
  f.bridge.receiveSlack(routed('100.1', '200.2', 'review')); await f.bridge.drain(); const current = reviewId(f);
  await f.restart();
  assert.equal(f.bridge.receiveWecom(frame('old', 'alice', { text: { content: `/review ${old} yes` } })), false);
  assert.equal(f.bridge.receiveWecom(frame('current', 'alice', { text: { content: `/review ${current} yes` } })), true);
  await f.bridge.drain(); await f.restart();
  assert.equal(f.bridge.receiveWecom(frame('replay', 'alice', { text: { content: `/review ${current} yes` } })), false);
  f.bridge.receiveSlack(routed('100.1', '200.3', 'review')); await f.bridge.drain(); const expires = reviewId(f);
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

test('plain owner replies preserve pending reviews and acknowledgments do not open new reviews', async t => {
  const f = fixture(t); f.bridge.receiveWecom(group('plain-owner')); await f.bridge.drain();
  assert.match(f.posted[0].text, /\[wecom:review\]/);
  f.bridge.receiveSlack(routed('100.1', '200.1', 'review', 'Please review')); await f.bridge.drain();
  const id = reviewId(f);
  f.bridge.receiveSlack(routed('100.1', '200.2', 'owner', 'Still working')); await f.bridge.drain();
  assert.deepEqual(f.sent.at(-1), { target: 'alice', text: 'Still working' });
  assert.equal(reviewId(f), id);
  assert.equal(f.store.get('SELECT count(*) n FROM reviews').n, 1);
  assert.equal(f.bridge.receiveWecom(frame('decision', 'alice', { text: { content: `/review ${id} revise it` } })), true);
  await f.bridge.drain(); assert.equal(f.posted.at(-1).thread_ts, '100.1');
  f.bridge.receiveSlack(routed('100.1', '200.3', 'owner', 'Received')); await f.bridge.drain();
  assert.deepEqual(f.sent.at(-1), { target: 'alice', text: 'Received' });
  assert.equal(f.store.get('SELECT count(*) n FROM reviews').n, 1);
  assert.equal(f.store.get('SELECT status FROM reviews WHERE id=?', id).status, 'consumed');
  assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE direction='wecom' AND lane!='owner'").n, 0);
});

test('review and plain owner share the private lane; unknown blocks both without blocking group', async t => {
  for (const first of ['owner', 'review']) {
    const attempts = [];
    const f = fixture(t, { wecom: { ack: async () => {}, send: async (target, text) => { attempts.push({ target, text }); if (target === 'alice') throw new Error('unknown'); return { errcode: 0 }; } } });
    f.bridge.receiveWecom(group('shared-lane')); await f.bridge.drain();
    f.bridge.receiveSlack(routed('100.1', '200.1', first)); await f.bridge.drain();
    f.bridge.receiveSlack(routed('100.1', '200.2', first === 'owner' ? 'review' : 'owner')); await f.bridge.drain();
    f.bridge.receiveSlack(routed('100.1', '200.3', 'group', 'Public status')); await f.bridge.drain();
    await f.restart(); await f.bridge.drain();
    assert.deepEqual(attempts.map(x => x.target), ['alice', 'group-2']);
    assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE lane='owner' AND status='pending'").n, 1);
    assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE lane='review'").n, 0);
  }
});

test('existing review rows and pinned private queue payloads survive restart unchanged', async t => {
  const f = fixture(t); f.bridge.receiveWecom(group('existing')); await f.bridge.drain();
  const request = f.store.get('SELECT * FROM requests');
  const id = '12345678-1234-1234-1234-123456789abc';
  // Model an already-persisted pre-split owner review and pending delivery.
  f.store.run('INSERT INTO reviews VALUES (?,?,?,?)', id, request.id, request.expires, 'pending');
  const text = `Existing review\n/review ${id} 你的意见`;
  f.store.addJob(request.id, 'wecom', { text }, 'owner', 'alice');
  const previous = f.store.get('SELECT * FROM reviews WHERE id=?', id);
  await f.restart(); await f.bridge.drain();
  assert.deepEqual(f.store.get('SELECT * FROM reviews WHERE id=?', id), previous);
  assert.deepEqual(f.sent, [{ target: 'alice', text }]);
  f.bridge.receiveSlack(routed('100.1', '200.1', 'owner', 'Acknowledged')); await f.bridge.drain();
  assert.deepEqual(f.store.get('SELECT * FROM reviews WHERE id=?', id), previous);
  assert.equal(f.bridge.receiveWecom(frame('existing-answer', 'alice', { text: { content: `/review ${id} yes` } })), true);
  await f.bridge.drain(); assert.equal(f.posted.at(-1).thread_ts, '100.1');
});

test('application root hook runs only for authenticated allowlisted root events', async t => {
  const roots = [];
  const f = fixture(t, { application: { receiveRoot: (_bridge, event) => { roots.push(event); return true; } } });
  const root = reply({ thread_ts: undefined });
  for (const event of [reply(), { ...root, bot_id: 'BOTHER' }, { ...root, channel: 'COTHER' }, { ...root, subtype: 'message_changed' }]) assert.equal(f.bridge.receiveSlack(event), false);
  assert.equal(f.bridge.receiveSlack(root), true);
  assert.equal(roots.length, 1);
  assert.equal(fixture(t).bridge.receiveSlack(root), false);
});

test('application owner hook runs inside dedup transaction and never for group text', async t => {
  const calls = [];
  const application = { receiveOwnerText(bridge, text, source) {
    assert.ok(bridge.store.get('SELECT id FROM seen WHERE id=?', source));
    calls.push(text);
    return text === '/custom reject' ? false : null;
  } };
  const f = fixture(t, { application });
  assert.equal(f.bridge.receiveWecom(frame('unauthorized', 'mallory')), false);
  assert.equal(f.bridge.receiveWecom(frame('owner')), true); await f.bridge.drain();
  assert.equal(f.bridge.receiveWecom(frame('owner')), false);
  assert.equal(f.bridge.receiveWecom(group('group')), true); await f.bridge.drain();
  assert.equal(f.bridge.receiveWecom(frame('rejected', 'alice', { text: { content: '/custom reject' } })), false);
  assert.deepEqual(calls, ['Hello 世界 😀', '/custom reject']);
  assert.equal(f.posted.length, 2);
});

function customRequest(store, overrides = {}) {
  const row = { id: 'custom-1', source: 'custom-source', target: 'alice', created: 1, expires: 2, root: '100.1', status: 'sent', kind: 'custom', owner: 'alice', channel: 'C123', ...overrides };
  store.run('INSERT INTO requests(id,source,target,created,expires,root,status,kind,owner,channel) VALUES (?,?,?,?,?,?,?,?,?,?)', ...Object.values(row));
  return row;
}

test('standalone transport retains unknown custom rows and queued work without sending', async t => {
  const f = fixture(t);
  const row = customRequest(f.store);
  f.store.db.exec('CREATE TABLE custom_records (value TEXT); INSERT INTO custom_records VALUES (\'preserve\')');
  f.store.addJob(row.id, 'wecom', { text: 'durable payload' }, 'owner', 'alice', 999999);
  f.store.prune(100000);
  await f.restart(); await f.bridge.drain();
  assert.equal(f.store.get('SELECT status FROM jobs').status, 'pending');
  assert.equal(f.store.get('SELECT value FROM custom_records').value, 'preserve');
  assert.equal(f.store.get('SELECT kind FROM requests').kind, 'custom');
  assert.equal(f.bridge.receiveSlack(reply()), false);
  assert.equal(f.sent.length, 0);
  f.store.prune(1000000);
  assert.equal(f.store.get('SELECT count(*) n FROM jobs').n, 0);
  assert.equal(f.store.get('SELECT count(*) n FROM requests').n, 1);
});

test('custom request authorization is explicit, fail-closed, owner/channel pinned and owner-only', async t => {
  for (const authorizeRequest of [undefined, () => false, () => 'yes', () => { throw new Error('denied'); }]) {
    const f = fixture(t, { application: { authorizeRequest } });
    customRequest(f.store);
    assert.equal(f.bridge.receiveSlack(reply()), false);
  }
  const f = fixture(t, { application: { authorizeRequest: () => true } });
  customRequest(f.store);
  for (const route of ['review', 'group']) assert.equal(f.bridge.receiveSlack(reply({ text: `[wecom:${route}] body` })), false);
  for (const [column, value] of [['owner', 'other'], ['channel', 'COTHER']]) {
    const previous = f.store.get(`SELECT ${column} value FROM requests`).value;
    f.store.run(`UPDATE requests SET ${column}=?`, value);
    assert.equal(f.bridge.receiveSlack(reply()), false);
    f.store.run(`UPDATE requests SET ${column}=?`, previous);
  }
  assert.equal(f.bridge.receiveSlack(reply()), true); await f.bridge.drain();
  assert.deepEqual(f.sent, [{ target: 'alice', text: 'Reply 世界 😀' }]);
  assert.equal(f.store.get('SELECT expires FROM jobs').expires, 100000 + config.ttlMs);
});

test('custom delivery revalidates application authorization and pinned channel after enqueue', async t => {
  for (const change of ['application', 'channel']) {
    let allow = true;
    const c = { ...config };
    const f = fixture(t, { config: c, application: { authorizeRequest: () => allow } });
    customRequest(f.store);
    f.bridge.wecomReady = false;
    assert.equal(f.bridge.receiveSlack(reply()), true); await f.bridge.drain();
    if (change === 'application') allow = false;
    else c.slackChannel = 'COTHER';
    f.bridge.wecomReady = true; await f.bridge.drain();
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.get('SELECT status FROM jobs').status, 'unknown');
  }
});

test('application initialization is explicit and handled owner text is not also forwarded', async t => {
  let initialized = false;
  const application = {
    initialize({ store, config: c }) { assert.ok(store); assert.equal(c.ownerUser, 'alice'); initialized = true; },
    receiveOwnerText(bridge, text) {
      assert.equal(initialized, true);
      if (text !== '/custom answer') return null;
      const row = customRequest(bridge.store, { expires: 999999 });
      bridge.store.addJob(row.id, 'slack', { text: 'handled', part: 1, parts: 1 }, 'slack', 'C123', 999999);
      return row.id;
    },
    authorizeRequest: () => true,
  };
  const f = fixture(t, { application });
  assert.equal(initialized, false);
  application.initialize({ store: f.store, config });
  assert.equal(f.bridge.receiveWecom(frame('custom', 'alice', { text: { content: '/custom answer' } })), true);
  await f.bridge.drain();
  assert.equal(f.posted.length, 1);
  assert.equal(f.posted[0].text, 'handled');
  assert.equal(f.posted[0].thread_ts, '100.1');
  assert.equal(f.store.get('SELECT count(*) n FROM requests').n, 1);
});

test('active WeCom multipart sends are conservatively paced across requests', async t => {
  const waits = []; const f = fixture(t, { wait: async ms => waits.push(ms) });
  f.bridge.receiveWecom(frame('paced-output')); await f.bridge.drain(); waits.length = 0;
  f.bridge.receiveSlack(reply({ text: '[wecom:owner]' + 'x'.repeat(7000) })); await f.bridge.drain();
  assert.equal(f.sent.length, 3); assert.equal(waits[0], 0);
  assert.ok(waits.slice(1).every(ms => ms > 3500 && ms <= 4000));
  f.bridge.receiveSlack(reply({ ts: '100.3', text: '[wecom:owner]next' })); await f.bridge.drain();
  assert.ok(waits.at(-1) > 3500);
});

test('TTL, stop and connection readiness are rechecked after WeCom pacing', async t => {
  for (const boundary of ['expiry', 'stop', 'disconnect']) {
    let paused = false;
    const f = fixture(t, { wait: async () => {
      if (!paused) return;
      if (boundary === 'expiry') f.advance(config.ttlMs + 1);
      if (boundary === 'stop') f.bridge.stopping = true;
      if (boundary === 'disconnect') f.bridge.wecomReady = false;
    } });
    f.bridge.receiveWecom(frame(boundary)); await f.bridge.drain(); paused = true;
    f.bridge.receiveSlack(reply()); await f.bridge.drain(); assert.equal(f.sent.length, 0);
    assert.equal(f.store.get("SELECT status FROM jobs WHERE direction='wecom'").status, boundary === 'expiry' ? 'expired' : 'pending');
    if (boundary === 'disconnect') { paused = false; f.bridge.wecomReady = true; await f.bridge.drain(); assert.equal(f.sent.length, 1); }
  }
});

test('corrupt outbox payload is isolated without blocking other requests or logging content', async t => {
  const f = fixture(t);
  f.bridge.receiveWecom(frame('corrupt')); await f.bridge.drain();
  f.bridge.receiveWecom(frame('healthy')); await f.bridge.drain();
  f.bridge.wecomReady = false;
  f.bridge.receiveSlack(reply({ text: '[wecom:owner]sensitive synthetic payload' }));
  f.bridge.receiveSlack(reply({ thread_ts: '100.2', ts: '200.2', text: '[wecom:owner]healthy reply' }));
  await f.bridge.drain();
  f.store.run("UPDATE jobs SET payload='not JSON sensitive synthetic payload' WHERE id=(SELECT MIN(id) FROM jobs WHERE direction='wecom')");
  f.bridge.wecomReady = true; await f.bridge.drain();
  assert.deepEqual(f.sent, [{ target: 'alice', text: 'healthy reply' }]);
  assert.deepEqual(f.store.all("SELECT status FROM jobs WHERE direction='wecom' ORDER BY id").map(x => x.status), ['unknown', 'sent']);
  assert.ok(f.logs.some(([event, fields]) => event === 'delivery_unknown' && fields.stage === 'payload'));
  assert.ok(!JSON.stringify(f.logs).includes('sensitive synthetic payload'));
  await f.restart(); await f.bridge.drain(); assert.equal(f.sent.length, 1);
});

test('concurrent drain calls and duplicate ingress share one active pump', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let posts = 0;
  t.after(() => release());
  const f = fixture(t, { slack: { post: async () => { posts++; if (posts === 1) await gate; return { ok: true, ts: `100.${posts}` }; } } });
  f.bridge.receiveWecom(frame('concurrent-one'));
  const first = f.bridge.drain();
  assert.equal(f.bridge.receiveWecom(frame('concurrent-one')), false);
  assert.equal(f.bridge.receiveWecom(frame('concurrent-two')), true);
  assert.equal(f.bridge.drain(), first);
  release(); await first;
  assert.equal(posts, 2); assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE status='sent'").n, 2);
});

test('ACK followed by local persistence failure stays unknown without replay or raw error logging', async t => {
  const f = fixture(t); f.bridge.receiveWecom(frame('persist-failure')); await f.bridge.drain();
  const run = f.store.run.bind(f.store);
  f.store.run = (sql, ...args) => {
    if (sql.includes("status='sent'")) throw new Error('synthetic confidential database failure');
    return run(sql, ...args);
  };
  f.bridge.receiveSlack(reply()); await f.bridge.drain();
  assert.equal(f.sent.length, 1); assert.equal(f.store.get("SELECT status FROM jobs WHERE direction='wecom'").status, 'unknown');
  assert.ok(f.logs.some(([event, fields]) => event === 'delivery_unknown' && fields.stage === 'persistence'));
  assert.ok(!JSON.stringify(f.logs).includes('confidential'));
  await f.restart(); await f.bridge.drain(); assert.equal(f.sent.length, 1);
});

test('multiline Slack text is not flattened or reformatted by matching rich text blocks', async t => {
  const f = fixture(t); f.bridge.receiveWecom(frame('preserve-original-lines')); await f.bridge.drain();
  const body = '第一段\n第二行\n\n1. 项目一\n  说明\r\n最后一行\n';
  for (const [index, candidate] of [body.replace(/\s+/g, ' ').trim(), body.replace(/\n\n/g, '\n').replace(/  /g, ' '), body.replace(/\n/g, '\n\n')].entries()) {
    assert.equal(f.bridge.receiveSlack(reply({ ts: `700.${index}`, text: '[wecom:owner]\n'+body, blocks: richText(['[wecom:owner]\n'+candidate]) })), true);
    await f.bridge.drain(); assert.equal(f.sent.at(-1).text, body);
  }
});

test('LF-free text keeps original spacing when blocks add no line breaks', async t => {
  const f = fixture(t); f.bridge.receiveWecom(frame('preserve-original-spacing')); await f.bridge.drain();
  assert.equal(f.bridge.receiveSlack(reply({ text: '[wecom:owner]First   second', blocks: richText(['[wecom:owner]First second']) })), true);
  await f.bridge.drain(); assert.equal(f.sent[0].text, 'First   second');
});

test('preserving original newlines does not bypass conflicting rich text route rejection', async t => {
  const f = fixture(t); f.bridge.receiveWecom(group('newline-route-boundary')); await f.bridge.drain();
  for (const marker of ['group','review','unknown']) {
    assert.equal(f.bridge.receiveSlack(reply({ text: '[wecom:owner]\nFirst\nSecond', blocks: richText([`[wecom:${marker}]\nFirst\nSecond`]) })), false);
  }
  assert.equal(f.sent.length,0); assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE direction='wecom'").n,0);
});

const listSection = text => ({ type:'rich_text_section',elements:[{type:'text',text}] });
const listBlocks = (items, extra = {}, prefix = '[wecom:group]\nHeading\n\n') => [{type:'rich_text',elements:[listSection(prefix),{type:'rich_text_list',style:'bullet',elements:items.map(listSection),...extra}]}];
test('observed section/list shape restores paragraphs and list boundaries from flattened Slack text', async t => {
  const f=fixture(t);f.bridge.receiveWecom(group('list-shape'));await f.bridge.drain();
  const blocks=[{type:'rich_text',elements:[...richText(['[wecom:group]','\n','验收示例','\n','第一行','\n第二行\n'],['第二段\n','列表：'])[0].elements,{type:'rich_text_list',style:'bullet',elements:richText(['项目','甲'],['项目乙'])[0].elements}]}];
  const expected='验收示例\n第一行\n第二行\n\n第二段\n列表：\n• 项目甲\n• 项目乙';
  for(const [i,text] of ['验收示例 第一行 第二行 第二段 列表： • 项目甲 • 项目乙','验收示例 第一行 第二行 第二段 列表： - 项目甲 - 项目乙','验收示例 第一行 第二行 第二段 列表： 项目甲 项目乙'].entries()){
    assert.equal(f.bridge.receiveSlack(reply({ts:`800.${i}`,text:'[wecom:group] '+text,blocks})),true);await f.bridge.drain();assert.equal(f.sent.at(-1).text,expected);
  }
});
test('ordered list offsets and indentation restore layout without changing words',async t=>{
 const f=fixture(t);f.bridge.receiveWecom(group('ordered-layout'));await f.bridge.drain();
 f.bridge.receiveSlack(reply({text:'[wecom:group]Heading 5. First 6. Second',blocks:listBlocks(['First','Second'],{style:'ordered',offset:4,indent:1})}));await f.bridge.drain();assert.equal(f.sent[0].text,'Heading\n\n\n  5. First\n  6. Second');
});
test('unsupported or invalid list structures and changed list content retain original text',async t=>{
 const f=fixture(t);f.bridge.receiveWecom(group('list-fallback'));await f.bridge.drain();
 const invalid=[listBlocks(['Changed']),listBlocks(['First'],{style:'unknown'}),listBlocks(['First'],{indent:9}),listBlocks(['First'],{offset:-1}),listBlocks(['First'],{elements:[{type:'rich_text_list',elements:[]}]}),listBlocks(['First'],{elements:[{type:'rich_text_section',elements:[{type:'link',url:'https://example.com/'}]}]})];
 for(const [i,blocks]of invalid.entries()){f.bridge.receiveSlack(reply({ts:`810.${i}`,text:'[wecom:group]Heading First',blocks}));await f.bridge.drain();assert.equal(f.sent.at(-1).text,'Heading First');}
});
test('list support preserves original multiline text and still rejects conflicting routes',async t=>{
 const f=fixture(t);f.bridge.receiveWecom(group('list-routing'));await f.bridge.drain();
 const body='Heading\n\n• First\n• Second';
 f.bridge.receiveSlack(reply({text:'[wecom:group]\n'+body,blocks:listBlocks(['First','Second'])}));await f.bridge.drain();assert.equal(f.sent[0].text,body);
 assert.equal(f.bridge.receiveSlack(reply({ts:'820.2',text:'[wecom:owner]\n'+body,blocks:listBlocks(['First','Second'])})),false);assert.equal(f.sent.length,1);
 assert.equal(f.bridge.receiveSlack(reply({ts:'820.3',bot_id:'BOTHER',text:'[wecom:group]Heading First',blocks:listBlocks(['First'])})),false);
});
test('long list content retains paragraph breaks across UTF-8 chunks',async t=>{
 const f=fixture(t);f.bridge.receiveWecom(group('long-list'));await f.bridge.drain();const item='中😀'.repeat(700);const body='Heading\n\n\n• '+item+'\n• End';
 f.bridge.receiveSlack(reply({text:'[wecom:group]Heading '+item+' End',blocks:listBlocks([item,'End'])}));await f.bridge.drain();assert(f.sent.length>1);assert.equal(f.sent.map(x=>x.text.replace(/^\[\d+\/\d+\] /,'')).join(''),body);
});
