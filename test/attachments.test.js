import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { AttachmentRelay } from '../src/attachments.js';
import { fileType,dispositionFilename } from '../src/file-policy.js';
import { safeTransfer } from '../src/safe-https.js';
import { createWecomTransport } from '../src/runtime.js';
const requestId='11111111-1111-4111-8111-111111111111';
const config={wecomBotId:'BOT',ownerUser:'owner',allowedChats:new Set(['group-a','group-b']),slackChannel:'C123',replyBot:'BDITTO',ttlMs:3600000,maxBytes:32000,attachmentsEnabled:true,attachmentRepliesEnabled:true,attachmentUsers:new Set(['member']),attachmentHosts:new Set(['wework.qpic.cn']),attachmentMaxCount:3,slackToken:'synthetic-token-never-log'};
const aeskey=Buffer.alloc(32,9).toString('base64');
const image=()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==','base64');
const types=[['note.txt','text/plain',Buffer.from('synthetic plain text')],['trace.log','text/plain',Buffer.from('error: example only')],['report.html','text/html',Buffer.from('<html><script>never_run()</script><img src="https://invalid.example"></html>')],['report.pdf','application/pdf',Buffer.from('%PDF-1.7\nsynthetic header only\n%%EOF')],['report.doc','application/msword',Buffer.from('d0cf11e0a1b11ae100000000','hex')],['report.xls','application/vnd.ms-excel',Buffer.from('d0cf11e0a1b11ae100000000','hex')],['report.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',Buffer.from('504b030400000000','hex')],['report.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',Buffer.from('504b030400000000','hex')]];
function encrypt(buffer){const key=Buffer.from(aeskey,'base64'),pad=32-buffer.length%32,cipher=createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);return Buffer.concat([cipher.update(Buffer.concat([buffer,Buffer.alloc(pad,pad)])),cipher.final()]);}
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'bridge-attachment-test-')),store=new Store(dir),posts=[],sent=[],transfers=[],logs=[];let now=100000;
  let data=types[0][2],name=types[0][0],mime=types[0][1];
  const files={F1:{id:'F1',user:'UDITTO',mode:'hosted',is_external:false,is_public:false,public_url_shared:false,name,mimetype:mime,size:data.length,url_private_download:'https://files.slack.com/files-pri/T1-F1/download/private.txt',shares:{private:{C123:[{thread_ts:'100.1'}]}}}};
  const client={files:{info:async({file})=>({ok:true,file:files[file]}),getUploadURLExternal:async()=>({ok:true,file_id:'FUP',upload_url:'https://files.slack.com/upload/v1/synthetic'}),completeUploadExternal:async p=>({ok:true,files:p.files})}};
  const relay=new AttachmentRelay({config,client,now:()=>now,transfer:async(url,options)=>{
    transfers.push({url,token:options.slackToken,body:options.body?Buffer.from(options.body):null});
    if(options.body)return Buffer.from('OK');
    if(url.includes('/files-pri/'))return Buffer.from(data);
    return options.metadata?{buffer:encrypt(data),disposition:`attachment; filename="${name}"`,contentType:'application/octet-stream'}:encrypt(image());
  }});
  const wecom={ack:async()=>{},send:async()=>({errcode:0}),sendAttachment:async(target,attachment,filename,verify)=>{verify();sent.push({target,filename,kind:attachment.kind,buffer:Buffer.from(attachment.buffer)});return{errcode:0};}};
  const bridge=new Bridge({config,store,images:relay,wecom,now:()=>now,wait:async()=>{},slack:{post:async p=>{posts.push(p);return{ok:true,ts:`100.${posts.length}`};}},log:(...x)=>logs.push(x)});bridge.wecomReady=true;
  const seed=()=>store.run('INSERT INTO requests(id,source,target,created,expires,root,status,kind,owner,channel) VALUES (?,?,?,?,?,?,?,?,?,?)',requestId,'synthetic','group-a',now,now+config.ttlMs,'100.1','sent','group','owner','C123');
  t.after(async()=>{await bridge.stop();store.close();rmSync(dir,{recursive:true,force:true});});
  return{store,bridge,relay,wecom,files,posts,sent,transfers,logs,seed,setData(tuple){[name,mime,data]=tuple;Object.assign(files.F1,{name,mimetype:mime,size:data.length});},advance(ms){now+=ms;},async drain(){await Promise.all([...bridge.attachmentTasks]);await bridge.drain();}};
}
const reply=(extra={})=>({type:'message',subtype:'file_share',channel:'C123',bot_id:'BDITTO',user:'UDITTO',ts:'200.1',thread_ts:'100.1',text:`[wecom:group-files]${JSON.stringify({request:requestId,redacted:true})}`,files:[{id:'F1'}],...extra});
const incoming=(id='file')=>({body:{aibotid:'BOT',msgid:id,chattype:'group',chatid:'group-a',from:{userid:'member'},msgtype:'file',file:{url:'https://wework.qpic.cn/synthetic?secret=never-log',aeskey}}});

test('common file policy checks UTF-8, MIME and container headers without rendering or expanding',()=>{
  for(const [name,mime,data] of types)assert.equal(fileType(data,name,mime).type,name.split('.').at(-1));
  for(const [name,mime,data] of [['x.exe','application/octet-stream',Buffer.from('MZ')],['x.zip','application/zip',Buffer.from('PK')],['x.docm','application/octet-stream',Buffer.from('PK')],['x.txt','image/png',Buffer.from('hello')],['x.txt','text/plain',Buffer.from([0,1,2])],['x.txt','text/plain',Buffer.from([255,255])],['x.txt','text/plain',Buffer.from('#!/bin/sh\n')],['x.pdf','application/pdf',Buffer.from('not pdf')],['x.docx','application/octet-stream',Buffer.from('MZ executable')],['x.xls','application/vnd.ms-excel',Buffer.from('not OLE')]])assert.throws(()=>fileType(data,name,mime),name);
  assert.equal(dispositionFilename("attachment; filename*=UTF-8''report%20sample.txt"),'report sample.txt');
  for(const header of [undefined,'attachment','attachment; filename="../../x.txt"',"attachment; filename*=UTF-8''..%2Fx.txt",'attachment; filename="x.txt:payload.exe"'])assert.throws(()=>dispositionFilename(header));
});

test('all common types enter as encrypted group files and become actual Slack attachments',async t=>{
  const f=fixture(t);
  for(const [index,tuple] of types.entries()){
    f.setData(tuple);assert(f.bridge.receiveWecom(incoming(`file-${index}`)));await f.drain();
    const upload=f.transfers.filter(x=>x.body).at(-1);assert.deepEqual(upload.body,tuple[2]);
    assert.equal(f.store.all('SELECT status FROM requests').at(-1).status,'sent');assert.equal(f.relay.cache.size,0);
  }
  assert.equal(f.posts.length,types.length*2);assert(!JSON.stringify(f.store.all('SELECT * FROM jobs')).includes(aeskey));
});

test('HTML source is transported byte-for-byte with no script execution or subresource requests',async t=>{
  const f=fixture(t);f.setData(types[2]);assert(f.bridge.receiveWecom(incoming()));await f.drain();
  assert.deepEqual(f.transfers.find(x=>x.body).body,types[2][2]);assert.equal(f.transfers.length,2);assert(!f.transfers.some(x=>x.url.includes('invalid.example')));
});

test('Ditto attachment reply is pinned to original request/root/group and uploads real media bytes',async t=>{
  const f=fixture(t);f.seed();assert(f.bridge.receiveSlack(reply()));await f.drain();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].target,'group-a');assert.equal(f.sent[0].kind,'file');assert.deepEqual(f.sent[0].buffer,types[0][2]);assert.match(f.sent[0].filename,/^result-[0-9a-f-]+-1\.txt$/);
  assert.equal(f.transfers[0].token,config.slackToken);assert.equal(f.store.get('SELECT status FROM jobs').status,'sent');assert.equal(f.relay.cache.size,0);
  assert(!JSON.stringify(f.logs).includes(config.slackToken));assert(!JSON.stringify(f.store.all('SELECT * FROM jobs')).includes('/files-pri/'));
});

test('PNG, PDF, Word and Excel replies use appropriate image/file media kinds',async t=>{
  for(const tuple of [...types,['capture.png','image/png',image()]]){
    const f=fixture(t);f.seed();f.setData(tuple);assert(f.bridge.receiveSlack(reply()));await f.drain();assert.equal(f.sent.length,1);assert.equal(f.sent[0].kind,tuple[0].endsWith('.png')?'image':'file');assert.deepEqual(f.sent[0].buffer,tuple[2]);
  }
});

test('wrong author/root/request, DM, unredacted claims, extra URL/path keys and disabled feature reject before file lookup',async t=>{
  const f=fixture(t);f.seed();let lookups=0;f.relay.client.files.info=async()=>{lookups++;throw new Error('must not call');};
  for(const extra of [{bot_id:'BOTHER'},{channel:'COTHER'},{thread_ts:undefined},{thread_ts:'foreign'},{subtype:'message_changed'},{files:[{id:'../../file'}]},{text:`[wecom:group-files]{"request":"${requestId}","redacted":false}`},{text:`[wecom:group-files]{"request":"${requestId}","redacted":true,"url":"https://evil.test"}`},{text:'[wecom:group-files]{"request":"other","redacted":true}'}])assert.equal(f.bridge.receiveSlack(reply(extra)),false);
  f.bridge.config={...config,attachmentRepliesEnabled:false};assert.equal(f.bridge.receiveSlack(reply()),false);f.bridge.config=config;
  f.store.run("UPDATE requests SET kind='single',target='owner'");assert.equal(f.bridge.receiveSlack(reply()),false);assert.equal(lookups,0);
});

test('file metadata rejects foreign uploader, foreign/cross-root/public shares and unsafe sources before byte download',async t=>{
  for(const extra of [{user:'UOTHER'},{mode:'external'},{is_external:true},{is_public:true},{public_url_shared:true},{size:6*1024*1024},{name:'../../note.txt'},{name:'x.exe'},{name:'note.txt',mimetype:'image/png'},{shares:{private:{COTHER:[{thread_ts:'100.1'}]}}},{shares:{private:{C123:[{thread_ts:'other-root'}]}}},{shares:{private:{C123:[{thread_ts:'100.1'},{thread_ts:'other-root'}]}}},{url_private_download:'https://evil.test/x'},{url_private_download:'https://files.slack.com/other/x'}]){
    const f=fixture(t);f.seed();Object.assign(f.files.F1,extra);assert(f.bridge.receiveSlack(reply()));await f.drain();assert.equal(f.transfers.length,0);assert.equal(f.sent.length,0);assert.equal(f.store.get('SELECT status FROM jobs').status,'unknown');
  }
});

test('event and per-request file ID dedup block repeated file shares even under a new timestamp',async t=>{
  const f=fixture(t);f.seed();assert(f.bridge.receiveSlack(reply()));assert(!f.bridge.receiveSlack(reply()));await f.drain();assert(!f.bridge.receiveSlack(reply({ts:'200.2'})));assert.equal(f.sent.length,1);
});

test('unknown final media send never replays, and revocation/expiry before send stop delivery',async t=>{
  const f=fixture(t);f.seed();let calls=0;f.wecom.sendAttachment=async()=>{calls++;throw new Error('uncertain');};assert(f.bridge.receiveSlack(reply()));await f.drain();assert.equal(f.store.get('SELECT status FROM jobs').status,'unknown');await f.drain();assert.equal(calls,1);assert.equal(f.relay.cache.size,0);
  const revoked=fixture(t);revoked.seed();revoked.relay.client.files.info=async()=>{revoked.bridge.config={...config,allowedChats:new Set()};return{ok:true,file:revoked.files.F1};};assert(revoked.bridge.receiveSlack(reply()));await revoked.drain();assert.equal(revoked.sent.length,0);
  const expired=fixture(t);expired.seed();expired.relay.transfer=async()=>{expired.advance(60001);return Buffer.from(types[0][2]);};assert(expired.bridge.receiveSlack(reply()));await expired.drain();assert.equal(expired.sent.length,0);
});

test('Slack credentials are prohibited for non-private-file hosts or upload requests',()=>{
  for(const [url,options] of [['https://wework.qpic.cn/x',{hosts:config.attachmentHosts}],['https://files.slack.com/upload/v1/x',{hosts:new Set(['files.slack.com']),body:Buffer.from('x')}]])assert.throws(()=>safeTransfer(url,{...options,maxBytes:10,slackToken:'synthetic'}));
});

test('WeCom transport uses upload + aibot_send_msg media helper, not replyMedia or markdown links',async()=>{
  const calls=[];
  const transport=createWecomTransport({uploadMedia:async(buffer,options)=>{calls.push({buffer:Buffer.from(buffer),options});return{type:options.type,media_id:'synthetic-media'};},sendMediaMessage:async(...args)=>{calls.push(args);return{errcode:0};},replyMedia:()=>assert.fail('not passive reply')});
  const result=await transport.sendAttachment('group-a',{kind:'file',buffer:types[0][2]},'result.txt');assert.equal(result.errcode,0);assert.deepEqual(calls[1],['group-a','file','synthetic-media']);assert.deepEqual(calls[0].buffer,types[0][2]);
  await assert.rejects(transport.sendAttachment('group-a',{kind:'image',buffer:image()},'result.png',()=>{throw new Error('revoked');}));assert.equal(calls.length,3);
});

test('upload deadline prevents a late SDK upload from beginning final group send',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let completeUpload,sends=0;
  const transport=createWecomTransport({uploadMedia:()=>new Promise(resolve=>{completeUpload=resolve;}),sendMediaMessage:async()=>{sends++;return{errcode:0};}});
  const pending=transport.sendAttachment('group-a',{kind:'file',buffer:types[0][2]},'result.txt');
  const rejected=assert.rejects(pending,/Media send deadline/);t.mock.timers.tick(30000);await rejected;
  completeUpload({type:'file',media_id:'late'});await Promise.resolve();await Promise.resolve();assert.equal(sends,0);
});
