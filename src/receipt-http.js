import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { TextDecoder } from 'node:util';
import { feedbackBinding, feedbackDelivery, putFeedbackDelivery } from './feedback.js';

const localAddress = value => {
  if (value === '::1') return true;
  if (isIP(value) !== 4) return false;
  const [a,b] = value.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};
export function receiptHttpConfig(env, feedbackRepositories) {
  if (env.RECEIPT_HTTP_ENABLED && !['true','false'].includes(env.RECEIPT_HTTP_ENABLED)) throw Error('Invalid receipt HTTP configuration');
  if (env.RECEIPT_HTTP_ENABLED !== 'true') return { enabled:false };
  const list = key => new Set((env[key] || '').split(',').map(s=>s.trim()).filter(Boolean));
  const c = { enabled:true, host:env.RECEIPT_HTTP_HOST?.trim(), port:Number(env.RECEIPT_HTTP_PORT), clients:list('RECEIPT_HTTP_CLIENT_IPS'), repositories:list('RECEIPT_HTTP_REPOSITORIES') };
  // Network trust is explicit, not an assertion of application/process identity.
  if (env.RECEIPT_HTTP_TRUST_NETWORK !== 'true' || !localAddress(c.host) || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535 || !c.clients.size || [...c.clients].some(ip=>!localAddress(ip)) || !c.repositories.size || [...c.repositories].some(repo=>!feedbackRepositories.has(repo))) throw Error('Invalid receipt HTTP configuration');
  return c;
}

// Flat JSON only; JSON.parse alone would silently accept duplicate keys.
export function parseReceiptJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.values(parsed).some(v=>v !== null && typeof v === 'object')) throw Error('Invalid request');
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}:,]/g);
  const keys = new Set(); let i=1;
  while (tokens[i] !== '}') {
    const key = JSON.parse(tokens[i++]);
    if (keys.has(key) || tokens[i++] !== ':') throw Error('Invalid request');
    keys.add(key); i++;
    if (tokens[i] === ',') i++; else if (tokens[i] !== '}') throw Error('Invalid request');
  }
  return parsed;
}
const valid = (p, submit) => {
  const fields = submit ? ['repository','issue','deliveryId','text'] : ['repository','issue','deliveryId'];
  return Object.keys(p).length === fields.length && fields.every(k=>Object.hasOwn(p,k)) && typeof p.repository === 'string' && Number.isSafeInteger(p.issue) && p.issue > 0 && typeof p.deliveryId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.deliveryId) && (!submit || (typeof p.text === 'string' && !!p.text.trim() && Buffer.byteLength(p.text) <= 3000));
};
const view = d => ({ status:d ? (d.status === 'sent' ? 'wecom_ack' : d.status) : 'not_found' });

export async function startReceiptHttp(bridge) {
  const c = bridge.config.receiptHttp;
  if (!c?.enabled) return null; // No socket, credentials, state or timer when disabled.
  const reply = (res,code,body) => { if (!res.destroyed && !res.writableEnded) res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(body)); };
  const server = createServer((req,res) => {
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/,'');
    const port = server.address()?.port, host = c.host.includes(':') ? `[${c.host}]:${port}` : `${c.host}:${port}`;
    if (bridge.stopping || !c.enabled || !c.clients.has(peer) || req.headers.host !== host || ['origin','transfer-encoding','content-encoding'].some(key=>Object.hasOwn(req.headers,key))) { reply(res,403,{error:'unavailable'}); req.resume(); return; }
    const submit = req.url === '/v1/receipts';
    if (req.method !== 'POST' || (!submit && req.url !== '/v1/receipts/status')) { reply(res,404,{error:'not_found'}); req.resume(); return; }
    if (req.headers['content-type'] !== 'application/json') { reply(res,415,{error:'invalid_request'}); req.resume(); return; }
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 2 || length > 16384) { reply(res,413,{error:'invalid_request'}); req.resume(); return; }
    let size=0, chunks=[], complete=false;
    const deadline=setTimeout(()=>{complete=true;chunks=[];reply(res,408,{error:'timeout'});req.destroy();},5000);
    const cleanup=()=>clearTimeout(deadline);
    res.on('close',cleanup); req.on('error',cleanup); req.on('aborted',()=>{complete=true;chunks=[];cleanup();});
    req.on('data',chunk=>{size+=chunk.length;if(size>16384){complete=true;chunks=[];cleanup();reply(res,413,{error:'invalid_request'});req.destroy();}else if(!complete)chunks.push(chunk);});
    req.on('end',()=>{
      cleanup(); if(complete)return; complete=true;
      let p;
      try { p=parseReceiptJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))); if(!valid(p,submit))throw Error(); }
      catch { reply(res,400,{error:'invalid_request'});return; }
      try {
        const result=bridge.store.transaction(()=>{
          if(bridge.stopping || !c.enabled || !c.repositories.has(p.repository))return null;
          const b=feedbackBinding(bridge,p.repository,p.issue);
          if(!b?.active)return null;
          const d=feedbackDelivery(bridge.store,p.deliveryId);
          if(d && d.request!==b.request)return {code:409,body:{error:'conflict'}};
          if(submit && !putFeedbackDelivery(bridge.store,b,p.deliveryId,p.text))return {code:409,body:{error:'conflict'}};
          return {code:submit?202:200,body:submit?{status:'accepted',delivery:view(feedbackDelivery(bridge.store,p.deliveryId)).status}:view(d)};
        });
        if(!result){reply(res,403,{error:'unavailable'});return;}
        reply(res,result.code,result.body);
        if(submit)void bridge.drain();
      } catch { reply(res,503,{error:'unavailable'}); }
    });
  });
  server.maxConnections=32;
  server.headersTimeout=5000; server.requestTimeout=5000; server.keepAliveTimeout=1000;
  server.setTimeout(5000,socket=>socket.destroy());
  server.on('clientError',(_error,socket)=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:c.host,port:c.port},()=>{server.removeListener('error',reject);resolve();});});
  server.on('error',()=>bridge.log('receipt_http_error'));
  return { address:()=>server.address(), close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}) };
}
