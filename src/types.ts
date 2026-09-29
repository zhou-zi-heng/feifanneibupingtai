export interface Env {
  DB: D1Database; FILES: R2Bucket; SYNC_QUEUE: Queue<{id:string}>; ASSETS: Fetcher;
  OWNER_EMAIL?:string; ACCESS_TEAM_DOMAIN?:string; ACCESS_AUD?:string; TOKEN_KEY?:string;
  PUBLIC_URL?:string; LOCAL_DEV?:string;
}
export interface Person {email:string; subject:string; role:'admin'|'editor'; channels:string[]; permissions:{ctr:boolean;revenue:boolean;sync:boolean;export:boolean};owner:boolean;}
export type Row = Record<string, any>;
export class AppError extends Error {constructor(public status:number,message:string,public code='request_failed'){super(message);}}
export const now=()=>new Date().toISOString();
export const parse=<T=any>(value:any,fallback:T={} as T):T=>{try{return typeof value==='string'?JSON.parse(value):value??fallback;}catch{return fallback;}};
export const isAdmin=(p:Person)=>p.role==='admin';
export function allowed(p:Person,cid:string){if(!isAdmin(p)&&!p.channels.includes(cid))throw new AppError(403,'你没有此频道的访问权限。','forbidden');}
export function admin(p:Person){if(!isAdmin(p))throw new AppError(403,'此操作需要管理员权限。','forbidden');}
export function capability(p:Person,key:keyof Person['permissions']){if(!isAdmin(p)&&!p.permissions[key])throw new AppError(403,'管理员尚未授予此操作权限。','forbidden');}
export async function all(db:D1Database,sql:string,...args:any[]){return (await db.prepare(sql).bind(...args).all<Row>()).results;}
export async function one(db:D1Database,sql:string,...args:any[]){return db.prepare(sql).bind(...args).first<Row>();}
export async function run(db:D1Database,sql:string,...args:any[]){return db.prepare(sql).bind(...args).run();}
export async function batches(db:D1Database,statements:D1PreparedStatement[]){for(let i=0;i<statements.length;i+=60)await db.batch(statements.slice(i,i+60));}
export async function digest(value:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function textValue(value:any,max=500){return String(value??'').trim().slice(0,max);}
export function dates(start:any,end:any){
  const valid=(s:any)=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
  if(!valid(start)||!valid(end)||start>end||end>new Date().toISOString().slice(0,10)||start<'2005-01-01')throw new AppError(400,'请填写有效日期，开始不得晚于结束，结束不得晚于今天。');
  return {start:start as string,end:end as string};
}
export function videoId(value:string){let id=value.trim();try{const u=new URL(id);id=u.hostname==='youtu.be'?u.pathname.slice(1):u.searchParams.get('v')||u.pathname.split('/').at(-1)||'';}catch{}if(!/^[\w-]{11}$/.test(id))throw new AppError(400,'视频 ID 或链接无效。');return id;}
export function channelId(value:string){if(!/^UC[\w-]{22}$/.test(value))throw new AppError(400,'频道 ID 无效。');return value;}
