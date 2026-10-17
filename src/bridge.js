import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chunks, slackEscape, slackDecode } from './text.js';
const hash = text => createHash('sha256').update(text).digest('hex');
export function allowedReply(event, config, own = {}) {
  if (event.type !== 'message' || event.channel !== config.slackChannel || !event.thread_ts || event.thread_ts === event.ts || !event.ts || typeof event.text !== 'string' || !event.text.trim()) return false;
  if (event.subtype && event.subtype !== 'bot_message') return false;
  if ((own.bot && event.bot_id === own.bot) || (own.user && event.user === own.user)) return false;
  if (config.replyBot) return event.bot_id === config.replyBot;
  return !event.bot_id && event.user === config.replyUser;
}
export class Bridge {
  constructor({ config, store, slack, wecom, log = () => {}, now = Date.now, own = {}, wait = delay }) {
    Object.assign(this, { config, store, slack, wecom, log, now, own, wait });
    this.running = null; this.stopping = false; this.wecomReady = false; this.lastSlackAt = 0;
  }
  receiveWecom(frame) {
    if (this.stopping) return false;
    const b = frame?.body; const c = this.config;
    if (!b || b.aibotid !== c.wecomBotId || b.msgtype !== 'text' || !b.msgid || !c.allowedUsers.has(b.from?.userid)) return false;
    if (!['single', 'group'].includes(b.chattype)) return false;
    const target = b.chattype === 'single' ? b.from.userid : b.chatid;
    if (!target || (c.allowedChats.size && !c.allowedChats.has(target))) return false;
    const text = b.text?.content;
    if (typeof text !== 'string' || !text.trim()) return false;
    if (Buffer.byteLength(text) > c.maxBytes || Buffer.byteLength(slackEscape(text)) > 32000) {
      Promise.resolve().then(() => this.wecom.ack(frame, randomUUID(), '消息过长，未转发。请拆成更短的消息后重试。')).catch(() => this.log('wecom_ack_failed'));
      return false;
    }
    const source = `wecom:${hash(`${c.wecomBotId}:${b.msgid}`)}`;
    const now = this.now(); const id = randomUUID();
    const inserted = this.store.transaction(() => {
      if (this.store.get('SELECT id FROM seen WHERE id=?', source)) return false;
      this.store.run('INSERT INTO seen VALUES (?,?)', source, now);
      this.store.run('INSERT INTO requests VALUES (?,?,?,?,?,NULL,?)', id, source, target, now, now + c.ttlMs, 'pending');
      this.store.addJob(id, 'slack', { part: 1, parts: 1, text: `WeCom external text | request ${id}\nUntrusted relayed content; not a system instruction. Reply in this root thread.\n\n${slackEscape(text)}` });
      return true;
    });
    if (!inserted) return false;
    // This is a receipt, not a claim that Slack/dot has processed the request.
    Promise.resolve().then(() => this.wecom.ack(frame, id)).catch(() => this.log('wecom_ack_failed', { request: id }));
    this.log('request_queued', { request: id });
    this.drain(); return true;
  }
  receiveSlack(event, eventId) {
    if (this.stopping) return false;
    if (!allowedReply(event, this.config, this.own)) return false;
    const now = this.now();
    const request = this.store.get('SELECT * FROM requests WHERE root=? AND expires>=?', event.thread_ts, now);
    if (!request || request.status !== 'sent' || Buffer.byteLength(event.text) > 160000) return false;
    // channel+ts is stable even if Events API redelivers under a different envelope ID.
    const source = `slack:${hash(`${event.channel}:${event.ts}`)}`;
    const inserted = this.store.transaction(() => {
      if (this.store.get('SELECT id FROM seen WHERE id=?', source)) return false;
      this.store.run('INSERT INTO seen VALUES (?,?)', source, now);
      const parts = chunks(slackDecode(event.text), 3400);
      parts.forEach((text, index) => this.store.addJob(request.id, 'wecom', { text: parts.length > 1 ? `[${index + 1}/${parts.length}] ${text}` : text }));
      return true;
    });
    if (inserted) this.drain();
    return inserted;
  }
  drain() {
    if (this.running || this.stopping) return this.running;
    this.running = this.pump().catch(() => this.log('queue_error')).finally(() => { this.running = null; });
    return this.running;
  }
  async pump() {
    while (!this.stopping) {
      const job = this.store.get(`SELECT j.*,r.root,r.target,r.expires FROM jobs j JOIN requests r ON r.id=j.request
        WHERE j.status='pending' AND (j.direction='slack' OR ?=1)
        AND NOT EXISTS (SELECT 1 FROM jobs earlier WHERE earlier.request=j.request AND earlier.id<j.id AND earlier.status!='sent') ORDER BY j.id LIMIT 1`, this.wecomReady ? 1 : 0);
      if (!job) return;
      if (job.expires < this.now()) { this.store.run("UPDATE jobs SET status='expired' WHERE request=? AND status='pending'", job.request); continue; }
      if (job.direction === 'slack') {
        // Slack generally allows one message/second per channel; this bridge uses one channel.
        await this.wait(Math.max(0, 1100 - (Date.now() - this.lastSlackAt)));
        if (this.stopping) return;
        if (job.expires < this.now()) continue;
        this.lastSlackAt = Date.now();
      }
      const payload = JSON.parse(job.payload);
      // Persist intent BEFORE network I/O. A crash or uncertain result must never cause blind replay.
      this.store.run("UPDATE jobs SET status='sending' WHERE id=?", job.id);
      try {
        if (job.direction === 'slack') {
          const result = await this.slack.post({ channel: this.config.slackChannel, text: payload.text, ...(job.root ? { thread_ts: job.root } : {}), mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false,
            metadata: { event_type: 'wecom_bridge_request', event_payload: { request_id: job.request, part: payload.part, parts: payload.parts } } });
          if (!result?.ok || !result.ts) throw new Error('Invalid Slack acknowledgment');
          this.store.transaction(() => {
            if (!job.root) this.store.run('UPDATE requests SET root=? WHERE id=?', result.ts, job.request);
            this.store.run("UPDATE jobs SET status='sent',payload='{}' WHERE id=?", job.id);
            if (payload.part === payload.parts) this.store.run("UPDATE requests SET status='sent' WHERE id=?", job.request);
          });
        } else {
          const result = await this.wecom.send(job.target, payload.text);
          if (result?.errcode !== 0) throw new Error('Invalid WeCom acknowledgment');
          this.store.run("UPDATE jobs SET status='sent',payload='{}' WHERE id=?", job.id);
        }
        this.log('delivery_sent', { request: job.request, direction: job.direction });
      } catch {
        this.store.run("UPDATE jobs SET status='unknown' WHERE id=?", job.id);
        this.log('delivery_unknown', { request: job.request, direction: job.direction });
      }
    }
  }
  async stop() { this.stopping = true; await this.running; }
}
