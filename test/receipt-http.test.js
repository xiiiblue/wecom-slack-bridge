import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { startReceiptHttp, receiptHttpConfig, parseReceiptJson } from '../src/receipt-http.js';
const payload={repository:'example/project',issue:17,deliveryId:'http-example-v1',text:'Reviewed result'};
async function fixture(t,{fail=false}={}) {
  const dir=mkdtempSync(join(tmpdir(),'receipt-http-'));let store=new Store(dir),bridge,server,seq=0;
  const sent=[],posted=[];
  const config={wecomBotId:'synthetic-bot',ownerUser:'owner',slackChannel:'C123',replyBot:'BREPLY',feedbackUser:'UREPLY',allowedChats:new Set(['synthetic-group']),feedbackRepositories:new Set(['example/project']),ttlMs:1000,maxBytes:32000,receiptHttp:{enabled:true,host:'127.0.0.1',port:0,clients:new Set(['127.0.0.1']),repositories:new Set(['example/project'])}};
  const start=async()=>{
    bridge=new Bridge({config,store,now:()=>100,wait:async()=>{},slack:{post:async p=>{posted.push(p);return {ok:true,ts:'1.1'};}},wecom:{ack:async()=>{},send:async(target,text)=>{sent.push({target,text});if(fail)throw Error('private diagnostic');return {errcode:0};}}});
    server=await startReceiptHttp(bridge);
  };
  await start();
  t.after(async()=>{await server.close();await bridge.stop();store.close();rmSync(dir,{recursive:true,force:true});});
  const command=(action,p={})=>bridge.receiveSlack({type:'message',channel:'C123',bot_id:'BREPLY',user:'UREPLY',ts:`2.${++seq}`,thread_ts:'1.1',text:`[wecom:source-${action}]`+JSON.stringify({repository:'example/project',issue:17,...p})});
  return {config,sent,posted,get bridge(){return bridge;},get store(){return store;},get server(){return server;},command,
    async bind(issue=17){bridge.wecomReady=true;bridge.receiveWecom({body:{aibotid:'synthetic-bot',msgtype:'text',msgid:`synthetic-${issue}`,chattype:'group',chatid:'synthetic-group',from:{userid:'sender'},text:{content:'Synthetic request'}}});await bridge.drain();assert.equal(command('bind',{issue}),true);await bridge.drain();bridge.wecomReady=false;},
    async restart(){await server.close();await bridge.stop();store.close();store=new Store(dir);await start();},
    call(body=payload,{path='/v1/receipts',method='POST',headers={},raw}={}) {
      const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw??JSON.stringify(body));
      return new Promise((resolve,reject)=>{
        const req=request({host:'127.0.0.1',port:server.address().port,path,method,headers:{'content-type':'application/json','content-length':bytes.length,...headers}},res=>{let chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));});
        req.on('error',reject);req.end(bytes);
      });
    }
  };
}
test('disabled by default and enabled configuration requires explicit network trust, private literal addresses, exact clients and repo subset',async()=>{
  assert.deepEqual(receiptHttpConfig({},new Set()),{enabled:false});
  assert.equal(await startReceiptHttp({config:{receiptHttp:{enabled:false}}}),null);
  const env={RECEIPT_HTTP_ENABLED:'true',RECEIPT_HTTP_TRUST_NETWORK:'true',RECEIPT_HTTP_HOST:'127.0.0.1',RECEIPT_HTTP_PORT:'8765',RECEIPT_HTTP_CLIENT_IPS:'127.0.0.1',RECEIPT_HTTP_REPOSITORIES:'example/project'};
  assert.equal(receiptHttpConfig(env,new Set(['example/project'])).port,8765);
  for(const patch of [{RECEIPT_HTTP_ENABLED:'yes'},{RECEIPT_HTTP_TRUST_NETWORK:''},{RECEIPT_HTTP_HOST:'0.0.0.0'},{RECEIPT_HTTP_HOST:'example.com'},{RECEIPT_HTTP_HOST:'8.8.8.8'},{RECEIPT_HTTP_PORT:'0'},{RECEIPT_HTTP_PORT:'70000'},{RECEIPT_HTTP_CLIENT_IPS:''},{RECEIPT_HTTP_CLIENT_IPS:'0.0.0.0'},{RECEIPT_HTTP_REPOSITORIES:'other/project'}])assert.throws(()=>receiptHttpConfig({...env,...patch},new Set(['example/project'])));
});
test('HTTP admits existing pinned binding only, queries ACK, shares Slack delivery IDs and persists across prune/restart',async t=>{
  const f=await fixture(t);assert.equal((await f.call()).code,403);await f.bind();
  assert.deepEqual(await f.call(),{code:202,body:{status:'accepted',delivery:'pending'}});
  assert.equal(f.posted.length,2); // ingress and bind only: HTTP never creates a Slack receipt.
  const status={repository:payload.repository,issue:17,deliveryId:payload.deliveryId};
  assert.deepEqual((await f.call(status,{path:'/v1/receipts/status'})).body,{status:'pending'});
  f.bridge.wecomReady=true;await f.bridge.drain();assert.deepEqual(f.sent,[{target:'synthetic-group',text:payload.text}]);
  assert.deepEqual((await f.call(status,{path:'/v1/receipts/status'})).body,{status:'wecom_ack'});
  assert.equal(f.command('result',{deliveryId:payload.deliveryId,text:payload.text}),true);await f.bridge.drain();assert.equal(f.sent.length,1);
  f.store.prune(900000000);await f.restart();
  assert.equal((await f.call()).code,202);f.bridge.wecomReady=true;await f.bridge.drain();assert.equal(f.sent.length,1);
  assert.equal((await f.call({...payload,text:'changed'})).code,409);
  await f.bind(18);assert.equal((await f.call({...payload,issue:18})).code,409);
  assert.equal(f.store.get('SELECT count(*) n FROM feedback_deliveries').n,1);
});
test('strict HTTP and flat JSON reject duplicate/unknown/recipient/command fields, malformed input, origin, wrong peer and oversized bodies',async t=>{
  const f=await fixture(t);await f.bind();
  for(const patch of [{chat_id:'other'},{target:'other'},{bot_id:'BREPLY'},{command:'send'},{text:''},{text:'中'.repeat(1001)},{issue:0},{issue:1.5},{repository:'other/project'},{deliveryId:' bad'}]){
    const r=await f.call({...payload,...patch});assert.ok([400,403].includes(r.code));
  }
  for(const raw of ['{"repository":"example/project","repository":"example/project","issue":17,"deliveryId":"x","text":"ok"}','{"repository":"example/project","issue":17,"deliveryId":"x","text":"ok","te\\u0078t":"same"}','{}','[]','null','{ ','{"text":{"nested":1}}'])assert.equal((await f.call(null,{raw})).code,400);
  assert.throws(()=>parseReceiptJson('{"x":1,"x":2}'));
  assert.equal((await f.call(null,{raw:Buffer.from([0xff,0xff])})).code,400);
  assert.equal((await f.call(null,{raw:' '.repeat(16385)})).code,413);
  assert.equal((await f.call(payload,{headers:{origin:'https://example.com'}})).code,403);
  assert.equal((await f.call(payload,{headers:{origin:''}})).code,403);
  assert.equal((await f.call(payload,{headers:{'content-encoding':''}})).code,403);
  assert.equal((await f.call(payload,{headers:{host:'example.com'}})).code,403);
  assert.equal((await f.call(payload,{headers:{'content-type':'text/plain'}})).code,415);
  assert.equal((await f.call(payload,{method:'GET'})).code,404);
  assert.equal((await f.call(payload,{path:'/v1/receipts?target=other'})).code,404);
  f.config.receiptHttp.clients.clear();assert.equal((await f.call(payload,{headers:{'x-forwarded-for':'127.0.0.1'}})).code,403);
  assert.equal(f.store.get('SELECT count(*) n FROM feedback_deliveries').n,0);assert.equal(f.sent.length,0);
});
test('binding and live allowlists/identity checks cannot be disabled by HTTP; revoke blocks queued output',async t=>{
  for(const change of ['replyBot','feedbackUser','ownerUser','wecomBotId','slackChannel','allowedChats','feedbackRepositories','httpRepositories','revoke']){
    const f=await fixture(t);await f.bind();assert.equal((await f.call()).code,202);
    if(change==='revoke')assert.equal(f.command('revoke'),true);
    else if(change==='httpRepositories')f.config.receiptHttp.repositories.clear();
    else f.config[change]=['allowedChats','feedbackRepositories'].includes(change)?new Set():'OTHER';
    assert.equal((await f.call({...payload,deliveryId:'second'})).code,403);
    if(change==='httpRepositories')continue; // admission scope is separate from already admitted transport work.
    f.bridge.wecomReady=true;await f.bridge.drain();assert.equal(f.sent.length,0,change);
  }
});
test('transport unknown and crash sending recovery never replay; API exposes no private route or error',async t=>{
  const f=await fixture(t,{fail:true});await f.bind();await f.call();f.bridge.wecomReady=true;await f.bridge.drain();assert.equal(f.sent.length,1);
  const status={repository:payload.repository,issue:17,deliveryId:payload.deliveryId};
  assert.deepEqual((await f.call(status,{path:'/v1/receipts/status'})).body,{status:'unknown'});
  await f.restart();assert.equal((await f.call()).code,202);await f.call({...payload,deliveryId:'second'});f.bridge.wecomReady=true;await f.bridge.drain();assert.equal(f.sent.length,1);
  f.store.run("UPDATE jobs SET status='sending' WHERE id=(SELECT job FROM feedback_deliveries WHERE delivery_id='second')");await f.restart();
  assert.deepEqual((await f.call({...status,deliveryId:'second'},{path:'/v1/receipts/status'})).body,{status:'unknown'});
  const run=f.store.run.bind(f.store);f.store.run=()=>{throw Error('private diagnostic');};
  const r=await f.call({...payload,deliveryId:'third'});assert.deepEqual(r,{code:503,body:{error:'unavailable'}});f.store.run=run;
});
test('concurrent submissions enqueue once; transaction rollback leaves no partial delivery',async t=>{
  const f=await fixture(t);await f.bind();const results=await Promise.all(Array.from({length:8},()=>f.call()));assert.ok(results.every(r=>r.code===202));
  assert.equal(f.store.get('SELECT count(*) n FROM feedback_deliveries').n,1);
  const run=f.store.run.bind(f.store);f.store.run=(sql,...args)=>{if(sql.startsWith('INSERT INTO feedback_deliveries'))throw Error('disk');return run(sql,...args);};
  assert.equal((await f.call({...payload,deliveryId:'rollback'})).code,503);f.store.run=run;
  assert.equal(f.store.get('SELECT count(*) n FROM jobs WHERE direction=?','wecom').n,1);
});
test('incomplete request has a bounded deadline and shutdown closes idle sockets',async t=>{
  const f=await fixture(t);const socket=connect(f.server.address().port,'127.0.0.1');
  await new Promise(resolve=>socket.once('connect',resolve));
  socket.write(`POST /v1/receipts HTTP/1.1\r\nHost: 127.0.0.1:${f.server.address().port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  socket.resume();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.destroy();reject(Error('deadline exceeded'));},7000);socket.once('close',()=>{clearTimeout(timer);resolve();});});
  assert.equal(f.store.get('SELECT count(*) n FROM feedback_deliveries').n,0);
});
test('literal HTTP text shares decoded Slack identity; disabled ingress and busy port fail closed',async t=>{
  const f=await fixture(t);await f.bind();
  assert.equal(f.command('result',{deliveryId:'escaped',text:'A &amp; B'}),true);await f.bridge.drain();
  assert.equal((await f.call({...payload,deliveryId:'escaped',text:'A & B'})).code,202);
  assert.equal(f.store.get('SELECT count(*) n FROM feedback_deliveries').n,1);
  f.config.receiptHttp.enabled=false;assert.equal((await f.call()).code,403);f.config.receiptHttp.enabled=true;
  f.config.receiptHttp.port=f.server.address().port;
  await assert.rejects(()=>startReceiptHttp(f.bridge),{code:'EADDRINUSE'});
  f.config.receiptHttp.port=0;
});
