import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { startReceiptHttp, receiptHttpConfig } from '../src/receipt-http.js';

const payload = { repository:'example/project', name:'release', deliveryId:'release-1:start', text:'即将发布合成测试版本' };
async function fixture(t, { fail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(),'announcement-')), sent = [];
  let store = new Store(dir), bridge, server;
  const config = { wecomBotId:'synthetic-bot', ownerUser:'owner', slackChannel:'C123', replyBot:'BREPLY', feedbackUser:'UREPLY',
    allowedChats:new Set(['synthetic-group','another-group']), feedbackRepositories:new Set(['example/project']), ttlMs:1000, maxBytes:32000,
    receiptHttp:{enabled:true, host:'127.0.0.1', port:0, clients:new Set(['127.0.0.1']), repositories:new Set(['example/project']), announcementTargets:new Map([['example/project:release','synthetic-group']])} };
  const start = async () => {
    bridge = new Bridge({config,store,wait:async()=>{},slack:{post:async()=>{throw Error('Announcement must not use Slack');}},
      wecom:{send:async(target,text)=>{sent.push({target,text});if(fail)throw Error('synthetic');return {errcode:0};}}});
    server = await startReceiptHttp(bridge);
  };
  await start();
  t.after(async()=>{bridge.stopping=true;await bridge.drain();await server.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const call = (body=payload,path='/v1/announcements') => new Promise((resolve,reject)=>{
    const raw=typeof body==='string'?body:JSON.stringify(body), port=server.address().port;
    const req=request({host:'127.0.0.1',port,path,method:'POST',headers:{host:`127.0.0.1:${port}`,'content-type':'application/json','content-length':Buffer.byteLength(raw)}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(text)}));
    });req.on('error',reject);req.end(raw);
  });
  const restart=async()=>{bridge.stopping=true;await bridge.drain();await server.close();store.close();store=new Store(dir);await start();};
  return {config,call,restart,sent,get bridge(){return bridge;},get store(){return store;}};
}
const status = (p=payload) => ({repository:p.repository,name:p.name,deliveryId:p.deliveryId});
test('固定公告路由默认关闭，配置必须限于既有仓库和群，拒绝重复与额外字段',()=>{
  const env={RECEIPT_HTTP_ENABLED:'true',RECEIPT_HTTP_TRUST_NETWORK:'true',RECEIPT_HTTP_HOST:'127.0.0.1',RECEIPT_HTTP_PORT:'8765',RECEIPT_HTTP_CLIENT_IPS:'127.0.0.1',RECEIPT_HTTP_REPOSITORIES:'example/project'};
  const repos=new Set(['example/project']), chats=new Set(['synthetic-group']);
  assert.equal(receiptHttpConfig(env,repos,chats).announcementTargets.size,0);
  const valid={repository:'example/project',name:'release',chatId:'synthetic-group'};
  assert.equal(receiptHttpConfig({...env,RECEIPT_HTTP_ANNOUNCEMENT_TARGETS:JSON.stringify([valid])},repos,chats).announcementTargets.get('example/project:release'),'synthetic-group');
  for(const targets of [[{...valid,chatId:'other'}],[{...valid,repository:'other/project'}],[valid,valid],[{...valid,command:'run'}],{}]) {
    assert.throws(()=>receiptHttpConfig({...env,RECEIPT_HTTP_ANNOUNCEMENT_TARGETS:JSON.stringify(targets)},repos,chats));
  }
});
test('无需Issue绑定，状态查询不建记录；公告仅发到固定群并共享持久去重',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await f.call(status(),'/v1/announcements/status'),{code:200,body:{status:'not_found'}});
  assert.equal(f.store.get('SELECT count(*) n FROM announcement_bindings').n,0);
  assert.equal((await f.call()).code,202);
  f.bridge.wecomReady=true;await f.bridge.drain();
  assert.deepEqual(f.sent,[{target:'synthetic-group',text:payload.text}]);
  assert.equal((await f.call(status(),'/v1/announcements/status')).body.status,'wecom_ack');
  await f.restart();await f.call();f.bridge.wecomReady=true;await f.bridge.drain();assert.equal(f.sent.length,1);
  assert.equal((await f.call({...payload,text:'changed'})).code,409);
  assert.equal(f.store.get('SELECT count(*) n FROM feedback_bindings').n,0);
});
test('公告拒绝收件人、命令、Issue与重复字段；改配置不能重定向已固定队列',async t=>{
  const f=await fixture(t);
  for(const extra of [{chatId:'another-group'},{target:'another-group'},{command:'send'},{issue:1},{name:'missing'}]) assert.ok([400,403].includes((await f.call({...payload,...extra})).code));
  assert.equal((await f.call('{"repository":"example/project","name":"release","deliveryId":"id","text":"a","text":"b"}')).code,400);
  await f.call();f.config.receiptHttp.announcementTargets.set('example/project:release','another-group');
  assert.equal((await f.call({...payload,deliveryId:'second'})).code,403);
  f.bridge.wecomReady=true;await f.bridge.drain();assert.equal(f.sent.length,0);
});
test('撤销群、仓库、机器人或HTTP路由阻止公告出站',async t=>{
  for(const change of ['allowedChats','repositories','announcementTargets','wecomBotId']) {
    const f=await fixture(t);await f.call();
    if(change==='wecomBotId')f.config.wecomBotId='other';
    else if(change==='allowedChats')f.config.allowedChats.clear();
    else f.config.receiptHttp[change].clear();
    f.bridge.wecomReady=true;await f.bridge.drain();assert.equal(f.sent.length,0,change);
  }
});
test('未知发送跨重启不重放，后续同群公告继续阻断，不换ID绕过',async t=>{
  const f=await fixture(t,{fail:true});await f.call();f.bridge.wecomReady=true;await f.bridge.drain();
  assert.equal((await f.call(status(),'/v1/announcements/status')).body.status,'unknown');
  await f.restart();await f.call();await f.call({...payload,deliveryId:'release-1:end'});f.bridge.wecomReady=true;await f.bridge.drain();
  assert.equal(f.sent.length,1);
});
