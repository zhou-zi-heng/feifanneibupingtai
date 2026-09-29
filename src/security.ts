import {createRemoteJWKSet,jwtVerify} from 'jose';
import {Env,Person,AppError,one,parse,now,run} from './types';
const keySets=new Map<string,ReturnType<typeof createRemoteJWKSet>>();
export const local=(request:Request,env:Env)=>env.LOCAL_DEV==='true'&&['localhost','127.0.0.1'].includes(new URL(request.url).hostname);
export function configMissing(env:Env){return ['DB','FILES','SYNC_QUEUE','OWNER_EMAIL','TOKEN_KEY','ACCESS_TEAM_DOMAIN','ACCESS_AUD'].filter(k=>!env[k as keyof Env]);}
export async function identity(request:Request,env:Env):Promise<{email:string,subject:string}>{
  if(local(request,env))return {email:(request.headers.get('x-feifan-dev-email')||env.OWNER_EMAIL||'owner@example.test').toLowerCase(),subject:'local-validation'};
  if(!env.OWNER_EMAIL||!env.ACCESS_TEAM_DOMAIN||!env.ACCESS_AUD)throw new AppError(503,'首次部署尚未完成。请按部署教程设置 OWNER_EMAIL、ACCESS_TEAM_DOMAIN 和 ACCESS_AUD。','setup_required');
  const raw=(env.ACCESS_TEAM_DOMAIN||'').replace(/\/$/,'');
  const team=raw.startsWith('https://')?raw:`https://${raw}`;
  if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team))throw new AppError(503,'ACCESS_TEAM_DOMAIN 格式应为你的团队名.cloudflareaccess.com。','setup_required');
  const token=request.headers.get('Cf-Access-Jwt-Assertion');
  if(!token)throw new AppError(401,'请先启用 Cloudflare Access 并登录，再刷新页面。','login_required');
  try{
    if(!keySets.has(team))keySets.set(team,createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`),{timeoutDuration:5000}));
    const {payload}=await jwtVerify(token,keySets.get(team)!,{issuer:team,audience:env.ACCESS_AUD,algorithms:['RS256']});
    if(typeof payload.email!=='string'||!payload.sub)throw new Error();
    return {email:payload.email.toLowerCase(),subject:payload.sub};
  }catch{throw new AppError(401,'登录凭据无效或已过期。请重新通过 Cloudflare Access 登录。','login_required');}
}
export async function person(request:Request,env:Env):Promise<Person>{
  const who=await identity(request,env);
  if(who.email===env.OWNER_EMAIL?.trim().toLowerCase())return {...who,role:'admin',owner:true,channels:[],permissions:{ctr:true,revenue:true,sync:true,export:true}};
  let user;try{user=await one(env.DB,'SELECT * FROM ff_users WHERE email=?',who.email);}catch{}
  if(!user||user.disabled)throw new AppError(403,'此邮箱尚未被管理员邀请，或账号已停用。','not_invited');
  const permission=parse(user.permissions_json);
  return {...who,role:user.role==='admin'?'admin':'editor',owner:false,channels:parse(user.channels_json,[]),permissions:{ctr:permission.ctr===true,revenue:permission.revenue===true,sync:permission.sync===true,export:permission.export===true}};
}
export function mutation(request:Request){
  const url=new URL(request.url);
  if(request.headers.get('Origin')!==url.origin||request.headers.get('X-Feifan-Request')!=='1')throw new AppError(403,'页面来源校验失败，请在平台页面内操作。','invalid_origin');
}
export async function readJson(request:Request,max=250000){
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new AppError(415,'请求必须使用 JSON。');
  const text=await limitedText(request.body,max);try{return JSON.parse(text);}catch{throw new AppError(400,'请求内容不是有效 JSON。');}
}
export async function limitedText(body:ReadableStream<Uint8Array>|null,max:number){
  if(!body)return '';const reader=body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new AppError(413,'文件或请求过大，请拆分后重试。');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return new TextDecoder().decode(bytes);
}
function decode(s:string){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
function encode(b:Uint8Array){let s='';for(const v of b)s+=String.fromCharCode(v);return btoa(s);}
async function key(env:Env){
  let bytes:Uint8Array;try{bytes=decode(env.TOKEN_KEY||'');}catch{throw new AppError(503,'TOKEN_KEY 格式无效，请使用教程中的 32 字节 Base64 密钥。');}
  if(bytes.length!==32)throw new AppError(503,'请先设置 TOKEN_KEY（32 字节 Base64 密钥）。','setup_required');
  return crypto.subtle.importKey('raw',bytes as BufferSource,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
export async function seal(env:Env,value:any,label:string){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(label)},await key(env),new TextEncoder().encode(JSON.stringify(value)));return `${encode(iv)}.${encode(new Uint8Array(data))}`;}
export async function unseal(env:Env,value:string,label:string){try{const [iv,bytes]=value.split('.');const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(iv) as BufferSource,additionalData:new TextEncoder().encode(label)},await key(env),decode(bytes) as BufferSource);return JSON.parse(new TextDecoder().decode(data));}catch{throw new AppError(503,'授权凭据无法解密。请恢复原 TOKEN_KEY；更换密钥后需要重新连接频道。','credential_unreadable');}}
export async function audit(env:Env,actor:string,action:string,target:string){await run(env.DB,'INSERT INTO ff_audit(actor,action,target,created_at) VALUES(?,?,?,?)',actor,action,target,now());}
