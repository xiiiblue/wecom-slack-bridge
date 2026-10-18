import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const hash = text => createHash('sha256').update(text).digest('hex');

// An opt-in transport demonstration, never a business command or approval.
export function createStreamDemo({ env = process.env, config, store, replyStream, log = () => {}, now = Date.now, wait = delay }) {
  const phrase = env.WECOM_STREAM_DEMO_PHRASE;
  const start = env.WECOM_STREAM_DEMO_STARTS_AT;
  const end = env.WECOM_STREAM_DEMO_EXPIRES_AT;
  if (phrase === undefined && start === undefined && end === undefined) return null;
  const startsAt = Date.parse(start), expiresAt = Date.parse(end);
  if (typeof phrase !== 'string' || phrase.length < 12 || phrase.length > 100 || phrase.trim() !== phrase || /[\r\n]/.test(phrase)
    || !Number.isFinite(startsAt) || !Number.isFinite(expiresAt) || startsAt <= 0 || expiresAt <= startsAt || expiresAt - startsAt > 30 * 60000
    || config.allowedChats.size !== 1) throw new Error('Invalid bounded stream demo configuration');
  const [chat] = config.allowedChats;
  const claim = `stream-demo:${hash(`${config.wecomBotId}:${chat}:${phrase}:${startsAt}`)}`;
  let pending = null, stopping = false;
  const mark = stage => {
    store.run('INSERT OR IGNORE INTO seen VALUES (?,?)', `${claim}:${stage}`, now());
    log(`stream_demo_${stage}`);
  };
  async function run(reqId, streamId) {
    try {
      if (stopping || now() >= expiresAt) { mark('interrupted'); return; }
      const first = await replyStream({ headers: { req_id: reqId } }, streamId, '正在查看…（一次性流式演示）', false);
      if (first?.errcode !== 0) throw new Error('Unconfirmed stream start');
      mark('started');
      await wait(2500);
      if (stopping || now() >= expiresAt) { mark('interrupted'); return; }
      const last = await replyStream({ headers: { req_id: reqId } }, streamId, '流式更新测试完成：这是最终测试答案，没有执行任何业务操作。', true);
      if (last?.errcode !== 0) throw new Error('Unconfirmed stream finish');
      mark('finished');
    } catch {
      // Consumed before network I/O. Never retry or send an active-message fallback.
      mark('unknown');
    }
  }
  return {
    receive(frame) {
      const b = frame?.body;
      if (b?.aibotid !== config.wecomBotId || b.chattype !== 'group' || b.chatid !== chat
        || b.from?.userid !== config.ownerUser || b.msgtype !== 'text' || b.text?.content !== phrase) return false;
      // Matching demo text is isolated even after expiry/consumption: no normal ack or Slack root.
      const time = now();
      if (stopping || time < startsAt || time >= expiresAt) { log('stream_demo_inactive'); return true; }
      if (typeof b.msgid !== 'string' || !b.msgid || typeof frame.headers?.req_id !== 'string' || !frame.headers.req_id
        || frame.headers.req_id.length > 256 || !Number.isSafeInteger(b.create_time)
        || b.create_time < Math.floor(startsAt / 1000) || b.create_time > Math.floor(time / 1000) + 30) {
        log('stream_demo_invalid_callback'); return true;
      }
      const source = `wecom:${hash(`${config.wecomBotId}:${b.msgid}`)}`;
      const claimed = store.transaction(() => {
        if (store.get('SELECT id FROM seen WHERE id=?', source)) return false;
        store.run('INSERT INTO seen VALUES (?,?)', source, time);
        if (store.get('SELECT id FROM seen WHERE id=?', claim)) return false;
        store.run('INSERT INTO seen VALUES (?,?)', claim, time);
        return true;
      });
      if (!claimed) { log('stream_demo_already_consumed'); return true; }
      log('stream_demo_claimed');
      pending = run(frame.headers.req_id, randomUUID());
      // Keep all errors contained, including a storage failure while recording an outcome.
      pending = pending.catch(() => log('stream_demo_state_error'));
      return true;
    },
    async drain() { await pending; },
    async stop() { stopping = true; await pending; },
  };
}
