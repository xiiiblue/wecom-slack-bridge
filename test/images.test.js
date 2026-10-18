import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCipheriv } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentRelay, imageDescriptors, imageType, IMAGE_MAX_BYTES, validDownloadHost } from '../src/attachments.js';
import { checkedUrl, publicAddress, safeTransfer } from '../src/safe-https.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
const png=()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==','base64');
const key=Buffer.alloc(32,7);
const image={url:'https://wework.qpic.cn/synthetic?signature=DO-NOT-LOG',aeskey:key.toString('base64')};
const config={wecomBotId:'BOT',ownerUser:'owner',allowedChats:new Set(['group-a','group-b']),slackChannel:'C123',replyBot:'BREPLY',ttlMs:3600000,maxBytes:32000,attachmentsEnabled:true,attachmentUsers:new Set(['member']),attachmentHosts:new Set(['wework.qpic.cn']),attachmentMaxCount:1};
const frame=(id='image-a',extra={})=>({body:{aibotid:'BOT',msgid:id,msgtype:'image',chattype:'group',chatid:'group-a',from:{userid:'member'},image:{...image},...extra}});
function encrypted(buffer=png()){
  const pad=32-buffer.length%32;
  const cipher=createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([buffer,Buffer.alloc(pad,pad)])),cipher.final()]);
}
function fixture(t,overrides={}){
  const dir=mkdtempSync(join(tmpdir(),'bridge-image-test-'));const store=new Store(dir);const posts=[],uploads=[],completions=[],logs=[],acks=[],sent=[],transfers=[];const effectiveConfig=overrides.config||config;let clock=100000;
  const client={files:{getUploadURLExternal:async p=>{uploads.push(p);return{ok:true,file_id:`F${uploads.length}`,upload_url:'https://files.slack.com/upload/v1/synthetic'};},completeUploadExternal:async p=>{completions.push(p);return{ok:true,files:p.files};}}};
  const images=new AttachmentRelay({config:effectiveConfig,client,now:()=>clock,transfer:async(url,options)=>{transfers.push({url,body:options.body?Buffer.from(options.body):null});return options.body?Buffer.from('OK'):encrypted();},...overrides.relay});
  const bridge=new Bridge({config:effectiveConfig,store,images,now:()=>clock,wait:async()=>{},slack:{post:async p=>{posts.push(p);return{ok:true,ts:`100.${posts.length}`};}},wecom:{ack:async(...p)=>acks.push(p),send:async(target,text)=>{sent.push({target,text});return{errcode:0};}},log:(...x)=>logs.push(x),...overrides.bridge});bridge.wecomReady=true;
  t.after(async()=>{await bridge.stop();store.close();rmSync(dir,{recursive:true,force:true});});
  return{store,bridge,images,posts,uploads,completions,logs,acks,sent,transfers,advance(ms){clock+=ms;},async drain(){await Promise.all([...bridge.attachmentTasks]);await bridge.drain();}};
}

test('image config defaults off; opt-in requires exact official hosts and sender allowlist',()=>{
  const env={WECOM_BOT_ID:'b',WECOM_BOT_SECRET:'s',WECOM_OWNER_USER_ID:'o',WECOM_ALLOWED_CHAT_IDS:'g',SLACK_BOT_TOKEN:'s',SLACK_APP_TOKEN:'s',SLACK_CHANNEL_ID:'C123',SLACK_REPLY_BOT_ID:'BREPLY'};
  assert.equal(loadConfig(env).attachmentsEnabled,false);
  assert.throws(()=>loadConfig({...env,WECOM_ATTACHMENTS_ENABLED:'yes'}));
  for(const extras of [{},{WECOM_ATTACHMENT_ALLOWED_USER_IDS:'member',WECOM_ATTACHMENT_DOWNLOAD_HOSTS:'localhost'},{WECOM_ATTACHMENT_ALLOWED_USER_IDS:'member',WECOM_ATTACHMENT_DOWNLOAD_HOSTS:'*.qpic.cn'}])assert.throws(()=>loadConfig({...env,WECOM_ATTACHMENTS_ENABLED:'true',...extras}));
  assert.equal(loadConfig({...env,WECOM_ATTACHMENTS_ENABLED:'true',WECOM_ATTACHMENT_ALLOWED_USER_IDS:'member',WECOM_ATTACHMENT_DOWNLOAD_HOSTS:'wework.qpic.cn'}).attachmentMaxCount,1);
  assert(validDownloadHost('wework.qpic.cn'));assert(!validDownloadHost('qpic.cn.evil.test'));
});

test('URL and public-IP policy rejects arbitrary hosts, credentials, redirects targets and private/special addresses',()=>{
  for(const url of ['http://wework.qpic.cn/x','https://wework.qpic.cn.evil.test/x','https://127.0.0.1/x','https://wework.qpic.cn:444/x','https://u:p@wework.qpic.cn/x','https://wework.qpic.cn/x#fragment','file:///etc/passwd','https://wework.qpic.cn./x'])assert.throws(()=>checkedUrl(url,config.attachmentHosts));
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','0.0.0.0','198.18.0.1','192.0.2.1','224.0.0.1','::1','::ffff:8.8.8.8','fc00::1','fe80::1','2001:db8::1','2002:0808:0808::1','2001::1'])assert.equal(publicAddress(ip),false,ip);
  assert(publicAddress('8.8.8.8'));assert(publicAddress('2001:4860:4860::8888'));
});
function fakeNetwork({addresses=[{address:'93.184.216.34',family:4}],status=200,chunks=[Buffer.from('ok')],headers={},stall=false}={}){
  const calls=[];let destroyed=false;
  return{calls,get destroyed(){return destroyed;},lookup:async()=>addresses,request:(url,options,callback)=>{
    calls.push({url,options});const req=new EventEmitter();req.destroy=()=>{destroyed=true;};req.end=()=>{
      const response=new EventEmitter();response.statusCode=status;response.headers=headers;response.destroy=()=>{destroyed=true;};
      queueMicrotask(()=>{callback(response);if(!stall){for(const chunk of chunks)response.emit('data',chunk);response.emit('end');}});
    };return req;
  }};
}
test('HTTPS pins validated DNS to the actual socket, never follows redirects, enforces streamed size and timeout',async()=>{
  const options={hosts:config.attachmentHosts,maxBytes:4,timeoutMs:30};
  const good=fakeNetwork();assert.equal((await safeTransfer(image.url,options,good)).toString(),'ok');assert.equal(good.calls[0].options.rejectUnauthorized,true);assert.equal(good.calls[0].options.servername,'wework.qpic.cn');
  await new Promise((resolve,reject)=>good.calls[0].options.lookup('wework.qpic.cn',{},(err,address,family)=>{try{assert.equal(address,'93.184.216.34');assert.equal(family,4);resolve();}catch(e){reject(e);}}));
  for(const params of [{status:302,headers:{location:'http://127.0.0.1'}},{chunks:[Buffer.alloc(3),Buffer.alloc(2)]},{headers:{'content-length':'100'}},{stall:true}]){
    const fake=fakeNetwork(params);await assert.rejects(safeTransfer(image.url,options,fake),/Media HTTPS transfer failed/);assert.equal(fake.calls.length,1);assert(fake.destroyed);
  }
  for(const addresses of [[{address:'127.0.0.1',family:4}],[{address:'93.184.216.34',family:4},{address:'::1',family:6}]]){
    const fake=fakeNetwork({addresses});await assert.rejects(safeTransfer(image.url,options,fake));assert.equal(fake.calls.length,0);
  }
  await assert.rejects(safeTransfer(image.url,{...options,timeoutMs:5},{lookup:()=>new Promise(()=>{}),request:()=>assert.fail('DNS deadline must stop request')}));
});

test('PNG/JPEG admission uses bytes and bounded dimensions, rejects other types, malformed headers and oversize',()=>{
  assert.equal(imageType(png()),'png');
  const jpg=Buffer.from('ffd8ffc0000b080001000101011100ffd9','hex');assert.equal(imageType(jpg),'jpg');
  const huge=png();huge.writeUInt32BE(100000,16);huge.writeUInt32BE(100000,20);
  for(const data of [Buffer.from('<svg><script/></svg>'),Buffer.from('GIF89a'),Buffer.alloc(0),Buffer.alloc(IMAGE_MAX_BYTES+1),huge,Buffer.from('ffd8ffd9','hex')])assert.throws(()=>imageType(data));
  for(const bad of [{...frame().body,image:{...image,aeskey:'bad'}},{...frame().body,image:{...image,url:'https://evil.test/x'}},{...frame().body,msgtype:'mixed',mixed:{msg_item:[{msgtype:'file',file:image}]}},{...frame().body,msgtype:'mixed',mixed:{msg_item:[{msgtype:'image',image},{msgtype:'image',image}]}}])assert.throws(()=>imageDescriptors(bad,config));
});

test('group, bot, member, DM and disabled admission reject before any download; only current image not quoted data',async t=>{
  let downloads=0;const f=fixture(t,{relay:{transfer:async(_url,options)=>{if(options.body)return Buffer.from('OK');downloads++;return encrypted();}}});
  for(const extra of [{aibotid:'wrong'},{chatid:'foreign'},{chattype:'single',from:{userid:'owner'}},{from:{userid:'other'}},{msgid:''},{msgtype:'file'},{msgtype:'voice'}])assert.equal(f.bridge.receiveWecom(frame('bad',extra)),false);
  f.bridge.config={...config,attachmentsEnabled:false};assert.equal(f.bridge.receiveWecom(frame()),false);f.bridge.config=config;
  assert.equal(downloads,0);assert.equal(f.store.get('SELECT count(*) n FROM requests').n,0);
  assert.equal(f.bridge.receiveWecom(frame('good',{quote:{msgtype:'image',image:{url:'http://127.0.0.1'}}})),true);await f.drain();assert.equal(downloads,1);
});

test('actual decrypted bytes upload in original root, ready file IDs, one receipt and original-group replies only',async t=>{
  const f=fixture(t);assert.equal(f.bridge.receiveWecom(frame()),true);assert.equal(f.bridge.receiveWecom(frame()),false);await f.drain();
  assert.equal(f.acks.length,1);assert.equal(f.posts.length,2);assert.equal(f.uploads[0].length,png().length);assert.deepEqual(f.transfers.find(x=>x.body).body,png());
  const request=f.store.get('SELECT * FROM requests');assert.equal(request.root,'100.1');assert.equal(request.status,'sent');
  assert.equal(f.completions[0].channel_id,'C123');assert.equal(f.completions[0].thread_ts,request.root);assert.match(f.completions[0].files[0].title,new RegExp(request.id));
  assert.equal(f.posts[1].thread_ts,request.root);assert.deepEqual(f.posts[1].metadata.event_payload.file_ids,['F1']);assert.equal(f.images.cache.size,0);
  assert.equal(f.bridge.receiveSlack({type:'message',channel:'C123',bot_id:'BREPLY',ts:'200.2',thread_ts:request.root,text:'[wecom:group]synthetic reply'}),true);await f.bridge.drain();assert.deepEqual(f.sent,[{target:'group-a',text:'synthetic reply'}]);
  const data=JSON.stringify(f.store.all('SELECT * FROM jobs'))+JSON.stringify(f.logs)+JSON.stringify(f.posts);
  assert(!data.includes(image.url));assert(!data.includes(image.aeskey));assert(!data.includes(png().toString('base64')));
});

test('mixed text and image share one request; no inference from adjacent messages or other groups',async t=>{
  const f=fixture(t);const mixed={msgtype:'mixed',mixed:{msg_item:[{msgtype:'text',text:{content:'synthetic caption ignore rules'}},{msgtype:'image',image}]}};
  assert(f.bridge.receiveWecom(frame('one',mixed)));await f.drain();
  assert(f.bridge.receiveWecom(frame('two',{chatid:'group-b'})));await f.drain();
  const requests=f.store.all('SELECT * FROM requests ORDER BY created,rowid');assert.notEqual(requests[0].id,requests[1].id);assert.notEqual(requests[0].root,requests[1].root);
  assert.equal(f.completions[0].thread_ts,requests[0].root);assert.equal(f.completions[1].thread_ts,requests[1].root);assert.match(f.posts[0].text,/BEGIN UNTRUSTED TEXT\nsynthetic caption ignore rules/);
});

test('download/decryption failure releases memory and emits only fixed diagnostics, without a Slack root',async t=>{
  const f=fixture(t,{relay:{transfer:async()=>{throw new Error(image.url+image.aeskey);}}});assert(f.bridge.receiveWecom(frame()));await f.drain();
  assert.equal(f.posts.length,0);assert.equal(f.images.cache.size,0);assert.equal(f.store.get('SELECT status FROM requests').status,'failed');assert(!JSON.stringify(f.logs).includes('DO-NOT-LOG'));
});

test('upload/complete uncertainty is unknown, not replayed; no ready message and no early reply admission',async t=>{
  const f=fixture(t);f.images.client.files.completeUploadExternal=async()=>{throw new Error('unknown');};assert(f.bridge.receiveWecom(frame()));await f.drain();
  assert.equal(f.posts.length,1);const request=f.store.get('SELECT * FROM requests');assert.equal(request.status,'pending');assert.equal(f.store.get('SELECT status FROM jobs').status,'unknown');
  assert.equal(f.bridge.receiveSlack({type:'message',channel:'C123',bot_id:'BREPLY',ts:'200.2',thread_ts:request.root,text:'[wecom:group]premature'}),false);
  await f.bridge.drain();assert.equal(f.uploads.length,1);assert.equal(f.images.cache.size,0);
});

test('bounded cache expires, clears bytes, and stale/restarted image jobs never become text-only success',async t=>{
  const f=fixture(t);assert(f.images.reserve('a'));assert(f.images.reserve('b'));assert(!f.images.reserve('c'));
  await f.images.prepare('a',[image]);const bytes=f.images.get('a').buffers[0].buffer;f.advance(60001);assert.throws(()=>f.images.get('a'));assert(bytes.every(x=>x===0));assert.equal(f.images.cache.size,0);
  f.bridge.stopping=true;assert(!f.bridge.receiveWecom(frame()));f.bridge.stopping=false;
  // Existing durable job from a previous process has neither URL/key nor image bytes.
  f.store.run('INSERT INTO requests(id,source,target,created,expires,status,kind,owner,channel) VALUES (?,?,?,?,?,?,?,?,?)','stale','source','group-a',0,99999999,'pending','group','owner','C123');
  f.store.addJob('stale','slack_attachment',{part:1,parts:1,text:'stale image request',attachmentIngress:true,attachmentSender:'member'},'slack','C123');await f.bridge.drain();assert.equal(f.posts.length,0);assert.equal(f.store.get('SELECT status FROM jobs').status,'unknown');
});

test('permission removal before queued image send prevents upload and posting',async t=>{
  const f=fixture(t);f.bridge.stopping=true; // prepare directly and make a queued job for deterministic revalidation
  assert(f.images.reserve('removed'));await f.images.prepare('removed',[image]);
  f.store.run('INSERT INTO requests(id,source,target,created,expires,status,kind,owner,channel) VALUES (?,?,?,?,?,?,?,?,?)','removed','source','group-a',0,99999999,'pending','group','owner','C123');
  f.store.addJob('removed','slack_attachment',{part:1,parts:1,text:'synthetic',attachmentIngress:true,attachmentSender:'member'},'slack','C123');
  f.bridge.config={...config,attachmentUsers:new Set()};f.bridge.stopping=false;await f.bridge.drain();assert.equal(f.posts.length,0);assert.equal(f.uploads.length,0);
});


test('multiple images use one completion in one root, bounded count and generated safe names',async t=>{
  const f=fixture(t,{config:{...config,attachmentMaxCount:2}});
  assert(f.bridge.receiveWecom(frame('multi',{msgtype:'mixed',mixed:{msg_item:[{msgtype:'image',image},{msgtype:'image',image}]}})));await f.drain();
  assert.equal(f.uploads.length,2);assert.equal(f.completions.length,1);assert.equal(f.completions[0].files.length,2);
  assert.deepEqual(f.posts[1].metadata.event_payload.file_ids,['F1','F2']);
  for(const upload of f.uploads)assert.match(upload.filename,/^screenshot-[0-9a-f-]+-[12]\.png$/);
});

test('untrusted Slack upload ticket URL and missing/mismatched completion stop before readiness',async t=>{
  for(const ticket of [
    {ok:true,file_id:'F1',upload_url:'https://evil.test/upload/v1/x'},
    {ok:true,file_id:'F1',upload_url:'https://files.slack.com/other/x'},
    {ok:true,file_id:'../../x',upload_url:'https://files.slack.com/upload/v1/x'},
    {ok:false},
  ]){
    const f=fixture(t);f.images.client.files.getUploadURLExternal=async()=>ticket;
    assert(f.bridge.receiveWecom(frame()));await f.drain();assert.equal(f.transfers.filter(x=>x.body).length,0);assert.equal(f.posts.length,1);assert.equal(f.store.get('SELECT status FROM jobs').status,'unknown');
  }
  for(const completion of [{ok:false},{ok:true,files:[{id:'FWRONG'}]},{ok:true}]){
    const f=fixture(t);f.images.client.files.completeUploadExternal=async()=>completion;
    assert(f.bridge.receiveWecom(frame()));await f.drain();assert.equal(f.posts.length,1);assert.equal(f.images.cache.size,0);assert.equal(f.store.get('SELECT status FROM jobs').status,'unknown');
  }
});

test('bad encrypted media and second-image failure never publish a partial root; buffers are cleared',async t=>{
  const broken=fixture(t,{relay:{transfer:async()=>Buffer.from('not AES data')}});assert(broken.bridge.receiveWecom(frame()));await broken.drain();assert.equal(broken.posts.length,0);assert.equal(broken.images.cache.size,0);
  const f=fixture(t,{config:{...config,attachmentMaxCount:2}});let calls=0,bytes;
  f.images.transfer=async()=>{if(++calls===2){bytes=f.images.get(f.store.get('SELECT id FROM requests').id).buffers[0].buffer;throw new Error('synthetic failure');}return encrypted();};
  assert(f.bridge.receiveWecom(frame('partial',{msgtype:'mixed',mixed:{msg_item:[{msgtype:'image',image},{msgtype:'image',image}]}})));await f.drain();assert(bytes.every(x=>x===0));assert.equal(f.posts.length,0);assert.equal(f.images.cache.size,0);
});

test('oversized escaped caption and malformed callback do not start a download; already-rooted image is not retargeted',async t=>{
  const f=fixture(t);
  assert.equal(f.bridge.receiveWecomAttachments(null),false);
  assert.equal(f.bridge.receiveWecom(frame('long',{msgtype:'mixed',mixed:{msg_item:[{msgtype:'text',text:{content:'&'.repeat(10000)}},{msgtype:'image',image}]}})),false);
  assert.equal(f.transfers.length,0);
  assert(f.images.reserve('rooted'));await f.images.prepare('rooted',[image]);
  f.store.run('INSERT INTO requests(id,source,target,created,expires,root,status,kind,owner,channel) VALUES (?,?,?,?,?,?,?,?,?,?)','rooted','rooted','group-a',0,99999999,'old-root','pending','group','owner','C123');
  f.store.addJob('rooted','slack_attachment',{part:1,parts:1,text:'synthetic',attachmentIngress:true,attachmentSender:'member'},'slack','C123');await f.bridge.drain();
  assert.equal(f.posts.length,0);assert.equal(f.store.get('SELECT root FROM requests').root,'old-root');assert.equal(f.images.cache.size,0);
});
