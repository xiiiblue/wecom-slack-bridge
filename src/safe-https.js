import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(ip,prefix,'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
for (const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(ip,prefix,'ipv6');
export function publicAddress(ip) {
  const family=isIP(ip);
  return family===4 ? !blocked.check(ip,'ipv4') : family===6 && global6.check(ip,'ipv6') && !blocked.check(ip,'ipv6');
}
export function checkedUrl(raw, hosts) {
  if (typeof raw!=='string' || raw.length>8192) throw new Error('Invalid media URL');
  const url=new URL(raw);
  if (url.protocol!=='https:' || url.username || url.password || url.hash || url.port || isIP(url.hostname) || !hosts.has(url.hostname)) throw new Error('Unapproved media URL');
  return url;
}
// No redirects, proxy environment, cookies or credentials. Validate ALL DNS answers, then pin
// the connection's lookup to one public address while retaining hostname TLS verification.
export function safeTransfer(raw, {hosts, maxBytes, timeoutMs=10000, body, metadata=false, slackToken}, {lookup=dnsLookup, request=httpsRequest}={}) {
  const url=checkedUrl(raw,hosts);
  if(slackToken && (body || url.hostname!=='files.slack.com' || !url.pathname.startsWith('/files-pri/'))) throw new Error('Credentials prohibited for this target');
  return new Promise((resolve,reject)=>{
    let req,res,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){req?.destroy();res?.destroy();reject(new Error('Media HTTPS transfer failed'));}else resolve(value);};
    const timer=setTimeout(()=>finish(true),timeoutMs);
    Promise.resolve().then(()=>lookup(url.hostname,{all:true,verbatim:true})).then(addresses=>{
      if(settled)return;
      if(!addresses.length || addresses.some(x=>!publicAddress(x.address))) throw new Error('Non-public address');
      const address=addresses[0];
      req=request(url,{method:body?'POST':'GET',agent:false,rejectUnauthorized:true,servername:url.hostname,lookup:(_host,options,cb)=>options?.all ? cb(null,[address]) : cb(null,address.address,address.family),
        headers:body?{'content-type':'application/octet-stream','content-length':body.length}:{accept:'application/octet-stream',...(slackToken?{authorization:`Bearer ${slackToken}`}:{})}},response=>{
        res=response;
        response.on('error',()=>finish(true));response.on('aborted',()=>finish(true));
        if(settled){response.destroy();return;}
        if(response.statusCode!==200 || (response.headers['content-length']!==undefined && (!/^\d+$/.test(response.headers['content-length']) || Number(response.headers['content-length'])>maxBytes))) return finish(true);
        const pieces=[];let size=0;
        response.on('data',chunk=>{if(settled)return;size+=chunk.length;if(size>maxBytes)finish(true);else pieces.push(chunk);});
        response.on('end',()=>{if(settled)return;const buffer=Buffer.concat(pieces);finish(false,metadata?{buffer,contentType:response.headers['content-type'],disposition:response.headers['content-disposition']}:buffer);});
      });
      req.on('error',()=>finish(true)); req.end(body);
    }).catch(()=>finish(true));
  });
}
