import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionFailure } from '../src/recovery.js';

const env = { WECOM_BOT_ID: 'synthetic-bot', WECOM_BOT_SECRET: 'synthetic-secret', WECOM_OWNER_USER_ID: 'owner', WECOM_ALLOWED_CHAT_IDS: 'synthetic-group', SLACK_BOT_TOKEN: 'synthetic-token', SLACK_APP_TOKEN: 'synthetic-app', SLACK_CHANNEL_ID: 'C123', SLACK_REPLY_BOT_ID: 'B123' };
const script = `
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { startBridge } from './src/runtime.js';
const mode = process.env.TEST_MODE;
const secretError = Object.assign(new Error('secret-token raw-url'), { code: 'slack_webapi_request_error', original: { code: 'ECONNRESET' } });
class Receiver { constructor(options) { assert.equal(options.autoReconnectEnabled, false); assert.equal(options.installerOptions.clientOptions.retryConfig.retries, 0); this.client = new EventEmitter(); Receiver.current = this; } }
class App {
 constructor(options) { assert.equal(options.deferInitialization, true); this.receiver = options.receiver; this.client = { auth: { test: async () => ({ok:true,user_id:'UBRIDGE',bot_id:'BBRIDGE'}) }, chat: { postMessage: () => { throw Error('unexpected send'); } } }; }
 async init() { if (mode === 'startup-network') throw secretError; if (mode === 'startup-auth') throw Object.assign(new Error('secret-token'), {data:{error:'invalid_auth'}}); }
 event() {} error() {}
 async start() { if (mode === 'socket-start-network') throw secretError; this.receiver.client.emit('authenticated', {url:'secret-token'}); this.receiver.client.emit('connected'); }
 async stop() { this.receiver.client.emit('disconnected'); console.log(JSON.stringify({event:'mock_stopped'})); }
}
class Wecom extends EventEmitter {
 connect() { this.isConnected = true; this.emit('authenticated'); }
 disconnect() { this.isConnected = false; }
}
const result = await startBridge({ adapters: { App, SocketModeReceiver: Receiver, WecomClient: Wecom } });
if (result) {
 if (mode === 'runtime-network') Receiver.current.client.emit('error', secretError);
 else if (mode === 'runtime-disconnect') Receiver.current.client.emit('disconnected');
 else process.emit('SIGTERM');
}
`;
for (const [mode, status] of [['startup-network',1],['startup-auth',78],['socket-start-network',1],['runtime-network',1],['runtime-disconnect',1],['healthy',0]]) {
 test('offline runtime: ' + mode, t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-recovery-')); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const result = spawnSync(process.execPath, ['--input-type=module','-e',script], {env:{...env,STATE_DIR:dir,TEST_MODE:mode},encoding:'utf8',timeout:5000});
  assert.equal(result.error, undefined); assert.equal(result.status,status,result.stderr + result.stdout);
  assert.ok(!result.stdout.includes('secret-token')); assert.ok(!result.stderr.includes('secret-token'));
  const events = result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.equal(events.filter(x=>x.event==='mock_stopped').length,1);
  if (mode.startsWith('startup') || mode==='socket-start-network') assert.ok(events.some(x=>x.event==='startup_failed'));
  else assert.ok(events.some(x=>x.event==='slack_connected'));
 });
}
test('failure classification never exposes arbitrary fields, preserves permanent failures', () => {
 assert.deepEqual(connectionFailure({code:'private-token',message:'secret'}),{code:'unclassified',exitCode:1});
 assert.deepEqual(connectionFailure({code:'slack_webapi_platform_error',data:{error:'token_revoked'}}),{code:'token_revoked',exitCode:78});
 assert.equal(connectionFailure({cause:{code:'ETIMEDOUT'}}).exitCode,1);
});
test('supervisor allows prolonged outage and next successful start without exhausting window', () => {
 const unit=readFileSync('deploy/wecom-slack-bridge.service','utf8');
 const read=key=>Number(new RegExp('^'+key+'=(\\d+)$','m').exec(unit)[1]);
 const interval=read('StartLimitIntervalSec'),burst=read('StartLimitBurst'),delay=read('RestartSec');
 const starts=[];
 for(let now=0;now<=1800;now+=delay){
  assert.ok(starts.filter(t=>now-t<interval).length<burst,'start limit would reject recovery');
  starts.push(now);
 }
 assert.match(unit,/RestartPreventExitStatus=78/);
});
