import { App, LogLevel } from '@slack/bolt';
import AiBot from '@wecom/aibot-node-sdk';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Bridge } from './bridge.js';

// SDK logs can include frames, signed URLs, and tokens. Never forward their arguments.
const log = (event, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} };
export function createWecomTransport(client) {
  return {
    ack: (frame, id, text = '收到，稍等') => client.replyStream(frame, id, text, true),
    send: (target, text) => client.sendMessage(target, { msgtype: 'markdown', markdown: { content: text } }),
  };
}
export async function startBridge({ createApplication } = {}) {
  let store, app, wecom, bridge, health, stopping = false;
  let startupStage = 'config';
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true; clearInterval(health);
    const deadline = setTimeout(() => process.exit(code || 1), 15000);
    try {
      // Keep connections alive briefly to finish the one in-flight send.
      await bridge?.stop();
      wecom?.disconnect();
      await app?.stop();
      store?.close();
    } catch { log('shutdown_error'); }
    clearTimeout(deadline); process.exitCode = code;
  }
  try {
    process.umask(0o077);
    const config = loadConfig();
    startupStage = 'state';
    store = new Store(config.stateDir);
    startupStage = 'application';
    const application = createApplication ? await createApplication({ config, store, env: process.env }) : null;
    await application?.initialize?.({ store, config });
    startupStage = 'connect';
    app = new App({ token: config.slackToken, appToken: config.slackAppToken, socketMode: true,
      logger: quietLogger, clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10000 } });
    wecom = new AiBot.WSClient({ botId: config.wecomBotId, secret: config.wecomSecret, logger: quietLogger, maxReconnectAttempts: 10, requestTimeout: 10000 });
    const identity = await app.client.auth.test();
    if (!identity.ok || !identity.user_id || !identity.bot_id) throw new Error('Cannot verify bridge identity');
    if (config.replyBot === identity.bot_id || config.replyUser === identity.user_id) { startupStage = 'identity'; throw new Error('Responder must not be bridge identity'); }
    bridge = new Bridge({ config, store, application, own: { bot: identity.bot_id, user: identity.user_id }, log,
      slack: { post: params => app.client.chat.postMessage(params) },
      wecom: createWecomTransport(wecom) });
    app.event('message', async ({ event, body }) => { if (!stopping) bridge.receiveSlack(event, body.event_id); });
    app.error(async () => log('slack_error'));
    wecom.on('message.text', frame => {
      try { if (!stopping) bridge.receiveWecom(frame); } catch { log('wecom_ingress_error'); }
    });
    wecom.on('authenticated', () => { bridge.wecomReady = true; log('wecom_authenticated'); bridge.drain(); });
    wecom.on('disconnected', () => { bridge.wecomReady = false; log('wecom_disconnected'); });
    wecom.on('reconnecting', attempt => log('wecom_reconnecting', { attempt }));
    wecom.on('error', error => {
      log('wecom_error');
      if (error.code === 'WS_RECONNECT_EXHAUSTED') void shutdown(1);
      if (error.code === 'WS_AUTH_FAILURE_EXHAUSTED') void shutdown(78);
    });
    wecom.on('event.disconnected_event', () => {
      // Another client owns this Bot ID. Exit permanently; do not fight it through supervisor restart.
      log('wecom_replaced_connection'); void shutdown(78);
    });
    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
    await app.start();
    if (!stopping) wecom.connect();
    health = setInterval(() => { store.prune(Date.now()); log('health', { wecomConnected: wecom.isConnected, queue: store.counts() }); bridge.drain(); }, 30000);
    log('bridge_started'); bridge.drain();
    return { config, store, bridge, shutdown };
  } catch {
    log('startup_failed', { stage: startupStage }); await shutdown(startupStage === 'connect' ? 1 : 78);
  }
}
