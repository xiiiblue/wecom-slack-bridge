import { TextDecoder } from 'node:util';
const policies={
  txt:['text/plain'],csv:['text/csv','text/plain'],md:['text/markdown','text/plain'],json:['application/json','text/plain'],xml:['application/xml','text/xml','text/plain'],log:['text/plain','text/x-log'],html:['text/html','text/plain'],htm:['text/html','text/plain'],
  pdf:['application/pdf'],doc:['application/msword'],xls:['application/vnd.ms-excel'],
  docx:['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx:['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};
export function safeFilename(name) {
  if(typeof name!=='string' || !name.length || name.length>200 || /[\/\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('.') || name.includes('..'))throw new Error('Unsafe attachment name');
  return name;
}
export function dispositionFilename(header) {
  if(typeof header!=='string' || header.length>1024)throw new Error('Missing attachment name');
  const extended=/filename\*=UTF-8''([^;\s]+)/i.exec(header);
  const plain=/filename=(?:"([^"\r\n]*)"|([^;\s]+))/i.exec(header);
  return safeFilename(extended?decodeURIComponent(extended[1]):plain?(plain[1]??plain[2]):null);
}
export function declaredFileType(name,mime='application/octet-stream') {
  const ext=safeFilename(name).split('.').at(-1).toLowerCase();
  const allowed=policies[ext];const type=mime.split(';')[0].trim().toLowerCase();
  if(!allowed || (type!=='application/octet-stream' && !allowed.includes(type)))throw new Error('Unsupported attachment type');
  return ext;
}
export function fileType(buffer,name,mime='application/octet-stream') {
  const ext=declaredFileType(name,mime);
  if(['txt','log','html','htm','csv','md','json','xml'].includes(ext)){
    const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || /^(?:MZ|#!)/.test(text))throw new Error('Binary or executable text');
  }else if(ext==='pdf'){
    if(buffer.toString('ascii',0,5)!=='%PDF-')throw new Error('Invalid PDF signature');
  }else if(['doc','xls'].includes(ext)){
    if(!buffer.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex')))throw new Error('Invalid Office signature');
  }else if(!buffer.subarray(0,4).equals(Buffer.from('504b0304','hex')))throw new Error('Invalid OOXML container signature');
  // Header/type checks only: never expand containers, render HTML/PDF, or execute macros.
  return {type:ext,kind:'file'};
}
