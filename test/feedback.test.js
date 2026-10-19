import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
function fixture(t, fail=false) {
  const dir=mkdtempSync(join(tmpdir(),'feedback-')); let now=1000, store=new Store(dir), bridge;
  const sent=[],posted=[],c={wecomBotId:'robot',ownerUser:'owner',slackChannel:'C123',replyBot:'BDOT',feedbackUser:'UDOT',allowedChats:new Set(['group']),feedbackRepositories:new Set(['example/project']),ttlMs:10000,maxBytes:32000};
  const deps={config:c,now:()=>now,wait:async()=>{},slack:{post:async p=>{posted.push(p);return {ok:true,ts:`1.${posted.length}`};}},wecom:{ack:async()=>{},send:async(target,text)=>{sent.push({target,text});if(fail)throw Error('private');return {errcode:0};}}};
  const start=()=>{bridge=new Bridge({...deps,store});bridge.wecomReady=true;};start();
  t.after(async()=>{await bridge.stop();store.close();rmSync(dir,{recursive:true,force:true});});
  return {get bridge(){return bridge;},get store(){return store;},c,sent,posted,
    async ingress(){bridge.receiveWecom({body:{aibotid:'robot',msgtype:'text',msgid:'m1',chattype:'group',chatid:'group',from:{userid:'sender'},text:{content:'question'}}});await bridge.drain();},
    command(action,p={},extra={}){return bridge.receiveSlack({type:'message',channel:'C123',bot_id:'BDOT',user:'UDOT',ts:`2.${posted.length}`,thread_ts:'1.1',text:`[wecom:source-${action}]`+JSON.stringify({repository:'example/project',issue:1,...p}),...extra});},
    async drain(){await bridge.drain();},async restart(){await bridge.stop();store.close();store=new Store(dir);start();},expire(ms=20000){now+=ms;store.prune(now);}};
}
test('cross-day prune and restart preserve pinned audience, dedup and queryable ACK',async t=>{
  const f=fixture(t);await f.ingress();assert.equal(f.command('bind'),true);await f.drain();f.expire();await f.restart();
  assert.equal(f.store.get("SELECT count(*) n FROM requests WHERE kind='group'").n,0);
  assert.equal(f.command('result',{deliveryId:'D1',text:'已验收'}),true);await f.drain();assert.deepEqual(f.sent,[{target:'group',text:'已验收'}]);
  assert.ok(f.posted.some(x=>x.text.includes('accepted')));f.expire(8*86400000);await f.restart();assert.equal(f.command('result',{deliveryId:'D1',text:'已验收'}),true);await f.drain();assert.equal(f.sent.length,1);
  assert.equal(f.command('result',{deliveryId:'D1',text:'changed'}),false);assert.equal(f.command('status',{deliveryId:'D1'}),true);await f.drain();assert.match(f.posted.at(-1).text,/wecom_ack/);assert.equal(f.posted.at(-1).thread_ts,'1.1');
  assert.equal(f.command('result',{deliveryId:'D2',text:'x'},{thread_ts:'other'}),false);
  assert.equal(f.command('bind',{}, {thread_ts:'other'}),false);
});
test('forged, expired, unproven, private sources and schema extras fail closed',async t=>{
  const f=fixture(t);assert.equal(f.command('bind'),false);await f.ingress();
  for(const extra of [{bot_id:'BAD'},{user:'UOTHER'},{user:undefined},{channel:'COTHER'},{subtype:'message_changed'},{thread_ts:undefined}])assert.equal(f.command('bind',{},extra),false);
  for(const p of [{chat_id:'other'},{target:'other'},{repository:'other/repo'},{issue:0}])assert.equal(f.command('bind',p),false);
  f.store.run('UPDATE requests SET ingress_bot=NULL');assert.equal(f.command('bind'),false);f.store.run("UPDATE requests SET ingress_bot='robot'");
  f.store.run("UPDATE requests SET kind='single'");assert.equal(f.command('bind'),false);f.store.run("UPDATE requests SET kind='group'");f.expire();assert.equal(f.command('bind'),false);
});
test('unknown never replays and blocks following result, independent Slack status remains available',async t=>{
  const f=fixture(t,true);await f.ingress();f.command('bind');await f.drain();f.command('result',{deliveryId:'D1',text:'one'});await f.drain();f.command('result',{deliveryId:'D2',text:'two'});await f.drain();await f.restart();await f.drain();assert.equal(f.sent.length,1);
  f.command('status',{deliveryId:'D1'});await f.drain();assert.match(f.posted.at(-1).text,/unknown/);assert.equal(f.store.get("SELECT status FROM jobs WHERE id=(SELECT job FROM feedback_deliveries WHERE delivery_id='D2')").status,'pending');
});
test('revocation and config changes block pending output without retargeting',async t=>{
  for(const change of ['replyBot','feedbackUser','ownerUser','wecomBotId','slackChannel','allowedChats','feedbackRepositories','revoke']){
    const f=fixture(t);await f.ingress();f.command('bind');await f.drain();f.bridge.wecomReady=false;f.command('result',{deliveryId:'D1',text:'one'});await f.drain();
    if(change==='revoke')assert.equal(f.command('revoke'),true);else f.c[change]=change.endsWith('Chats')||change.endsWith('Repositories')?new Set():'OTHER';
    await f.restart();await f.drain();assert.equal(f.sent.length,0,change);
  }
});
test('atomic binding admission and crash recovery do not replay sending',async t=>{
  const f=fixture(t);await f.ingress();const original=f.store.addJob;f.store.addJob=()=>{throw Error('disk');};assert.throws(()=>f.command('bind'),/disk/);assert.equal(f.store.get('SELECT count(*) n FROM feedback_bindings').n,0);f.store.addJob=original;
  f.command('bind');await f.drain();f.bridge.wecomReady=false;f.command('result',{deliveryId:'D1',text:'one'});await f.drain();f.store.run("UPDATE jobs SET status='sending' WHERE direction='wecom'");await f.restart();await f.drain();assert.equal(f.sent.length,0);assert.equal(f.store.get("SELECT status FROM jobs WHERE direction='wecom'").status,'unknown');
});
test('disabled feedback, oversized body and rolled-back result cannot leak or leave half records',async t=>{
  const f=fixture(t);await f.ingress();const repos=f.c.feedbackRepositories;f.c.feedbackRepositories=new Set();assert.equal(f.command('bind'),false);f.c.feedbackRepositories=repos;
  f.command('bind');await f.drain();assert.equal(f.command('result',{deliveryId:'D0',text:'中'.repeat(1001)}),false);
  const original=f.store.addJob;f.store.addJob=()=>{throw Error('disk');};assert.throws(()=>f.command('result',{deliveryId:'D1',text:'one'}),/disk/);f.store.addJob=original;
  assert.equal(f.store.get('SELECT count(*) n FROM feedback_deliveries').n,0);assert.equal(f.store.get("SELECT count(*) n FROM jobs WHERE direction='wecom'").n,0);
  assert.equal(f.command('result',{deliveryId:'D1',text:'one'}),true);await f.drain();assert.equal(f.sent.length,1);
});
test('delivery IDs cannot cross bindings, revocation preserves past ACK evidence',async t=>{
  const f=fixture(t);await f.ingress();f.command('bind');await f.drain();f.command('result',{deliveryId:'D1',text:'one'});await f.drain();
  assert.equal(f.command('bind',{issue:2}),true);await f.drain();assert.equal(f.command('result',{issue:2,deliveryId:'D1',text:'one'}),false);
  assert.equal(f.command('revoke'),true);await f.drain();assert.equal(f.command('status',{deliveryId:'D1'}),true);await f.drain();assert.match(f.posted.at(-1).text,/wecom_ack.*binding_active=0/);
  assert.equal(f.command('bind'),false);assert.equal(f.command('result',{deliveryId:'D2',text:'two'}),false);
});
