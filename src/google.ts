import {Env,AppError,Row,one,run,now,digest,batches} from './types';
import {seal,unseal,limitedText} from './security';
export const BASE_SCOPES=['https://www.googleapis.com/auth/youtube.readonly','https://www.googleapis.com/auth/yt-analytics.readonly'];
export const MONEY='https://www.googleapis.com/auth/yt-analytics-monetary.readonly';
const DATA='https://www.googleapis.com/youtube/v3/';
const ANALYTICS='https://youtubeanalytics.googleapis.com/v2/reports';
const REPORTING='https://youtubereporting.googleapis.com/v1/';
export class GoogleError extends AppError {constructor(status:number,message:string,public retryable=false){super(status,message,'google_error');}}
export async function http(url:string,init:RequestInit={}){
  let response:Response;
  try{response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw new GoogleError(502,'暂时无法连接 Google，任务可重试。',true);}
  if(!response.ok){
    let reason='';try{const body:any=await response.json();reason=typeof body.error==='string'?body.error:body.error?.errors?.[0]?.reason||body.error?.status||'';}catch{}
    reason=/^[\w-]{1,70}$/.test(reason)?reason:'';
    const retry=response.status===429||response.status>=500||['rateLimitExceeded','userRateLimitExceeded'].includes(reason);
    const hints:Record<number,string>={400:'请求参数或 OAuth 配置不被接受',401:'频道授权已失效，请重新连接',403:'缺少权限、API 未启用或配额不足',404:'所请求的频道、视频或报表当前不可用',429:'请求过于频繁，将稍后重试'};
    throw new GoogleError(response.status,`Google ${response.status}：${hints[response.status]||'请求失败'}${reason?`（${reason}）`:''}`,retry);
  }return response;
}
async function json(url:string,init:RequestInit={}):Promise<any>{return (await http(url,init)).json();}
export async function client(env:Env){const row=await one(env.DB,"SELECT cipher FROM ff_settings WHERE key='google_client'");if(!row)throw new AppError(400,'请先在连接与设置中导入 Google 网站 OAuth JSON。');return unseal(env,row.cipher,'google-client');}
export async function saveClient(env:Env,value:any){
  const config=value?.web;
  if(!config||!String(config.client_id).endsWith('.apps.googleusercontent.com')||typeof config.client_secret!=='string')throw new AppError(400,'请选择 Google Cloud 下载的“Web 应用”OAuth JSON；本地版的桌面客户端不能用于这里。');
  const existing=await one(env.DB,"SELECT cipher FROM ff_settings WHERE key='google_client'");
  if(existing){const prev=await unseal(env,existing.cipher,'google-client');const count=await one(env.DB,'SELECT count(*) n FROM ff_channels');if(count?.n&&prev.client_id!==config.client_id)throw new AppError(409,'已有频道连接，不能直接切换 OAuth 应用。请先备份并处理现有连接。');}
  const encrypted=await seal(env,{client_id:config.client_id,client_secret:config.client_secret},'google-client');
  await run(env.DB,"INSERT INTO ff_settings(key,cipher,updated_at) VALUES('google_client',?,?) ON CONFLICT(key) DO UPDATE SET cipher=excluded.cipher,updated_at=excluded.updated_at",encrypted,now());
}
export async function begin(env:Env,email:string,subject:string,origin:string,monetary:boolean){
  const config=await client(env);const state=crypto.randomUUID()+crypto.randomUUID();const verifier=crypto.randomUUID()+crypto.randomUUID();
  const challenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const redirect=(env.PUBLIC_URL||origin).replace(/\/$/,'')+'/oauth/callback';
  if(!redirect.startsWith('https://')&&!/^http:\/\/(localhost|127\.0\.0\.1):/.test(redirect))throw new AppError(400,'正式 OAuth 回调必须使用 HTTPS 网站地址。');
  const scopes=[...BASE_SCOPES,...(monetary?[MONEY]:[])];
  await run(env.DB,'DELETE FROM ff_oauth_states WHERE expires<?',Date.now());
  await run(env.DB,'INSERT INTO ff_oauth_states(id,email,subject,cipher,expires) VALUES(?,?,?,?,?)',await digest(state),email,subject,await seal(env,{verifier,redirect,scopes,clientId:config.client_id},'oauth-state'),Date.now()+600000);
  const params=new URLSearchParams({client_id:config.client_id,redirect_uri:redirect,response_type:'code',scope:scopes.join(' '),access_type:'offline',prompt:'consent select_account',state,code_challenge:challenge,code_challenge_method:'S256'});
  return 'https://accounts.google.com/o/oauth2/v2/auth?'+params;
}
export async function finish(env:Env,email:string,subject:string,query:URLSearchParams){
  const state=await one(env.DB,'DELETE FROM ff_oauth_states WHERE id=? AND email=? AND subject=? AND expires>? RETURNING *',await digest(query.get('state')||''),email,subject,Date.now());
  if(!state)throw new AppError(400,'授权已过期、已使用或与登录账号不符，请重新连接。');
  if(query.has('error')||!query.get('code'))throw new AppError(400,'Google 授权未完成，请重新选择需要的只读权限。');
  const pending=await unseal(env,state.cipher,'oauth-state');const config=await client(env);
  if(config.client_id!==pending.clientId)throw new AppError(400,'OAuth 应用已变更，请重新连接。');
  const token=await json('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({...config,grant_type:'authorization_code',code:query.get('code')!,redirect_uri:pending.redirect,code_verifier:pending.verifier})});
  const scopes=String(token.scope||pending.scopes.join(' ')).split(' ');
  if(!BASE_SCOPES.every(s=>scopes.includes(s)))throw new AppError(400,'未授予完整的 YouTube 和 Analytics 读取权限，请重新连接。');
  const channels:Row[]=[];let page='';const seen=new Set<string>();
  do{
    const params=new URLSearchParams({part:'snippet,contentDetails',mine:'true',maxResults:'50',...(page?{pageToken:page}:{})});
    const data=await json(DATA+'channels?'+params,{headers:{Authorization:'Bearer '+token.access_token}});
    channels.push(...(data.items||[]));page=data.nextPageToken||'';
    if(page&&seen.has(page))throw new AppError(502,'Google 频道分页未前进，请重新授权。');seen.add(page);
  }while(page);
  if(!channels.length)throw new AppError(400,'此身份没有返回可通过 API 访问的频道。请重新授权并选择具体频道；仅通过 Studio 邀请的身份可能不支持 API。');
  const statements:D1PreparedStatement[]=[];
  for(const item of new Map(channels.map(x=>[x.id,x])).values()){
    let refresh=token.refresh_token;
    if(!refresh){const prev=await one(env.DB,'SELECT credential FROM ff_channels WHERE id=?',item.id);if(prev)refresh=(await unseal(env,prev.credential,item.id)).refresh_token;}
    if(!refresh)throw new AppError(400,'Google 未返回离线授权令牌，请重新连接并确认授权。');
    const cipher=await seal(env,{refresh_token:refresh,access_token:token.access_token,expires:Date.now()+(token.expires_in||3600)*1000-60000},item.id);
    statements.push(env.DB.prepare("INSERT INTO ff_channels(id,title,uploads,credential,scopes_json,connected_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,uploads=excluded.uploads,credential=excluded.credential,scopes_json=excluded.scopes_json,connected_at=excluded.connected_at,auth_state='connected',last_error=NULL").bind(item.id,item.snippet.title,item.contentDetails?.relatedPlaylists?.uploads||'',cipher,JSON.stringify(scopes),now()));
  }
  await batches(env.DB,statements);return channels.map(x=>x.snippet.title);
}
export async function access(env:Env,cid:string,force=false){
  const channel=await one(env.DB,'SELECT credential FROM ff_channels WHERE id=?',cid);if(!channel)throw new AppError(404,'频道未连接。');
  const token=await unseal(env,channel.credential,cid);if(!force&&token.expires>Date.now())return token.access_token;
  try{
    const next=await json('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({...await client(env),grant_type:'refresh_token',refresh_token:token.refresh_token})});
    token.access_token=next.access_token;token.expires=Date.now()+(next.expires_in||3600)*1000-60000;
    const result=await run(env.DB,"UPDATE ff_channels SET credential=?,auth_state='connected',last_error=NULL WHERE id=? AND credential=?",await seal(env,token,cid),cid,channel.credential);
    if(!result.meta.changes)return access(env,cid);
    return token.access_token;
  }catch(error){if(error instanceof GoogleError&&[400,401].includes(error.status))await run(env.DB,"UPDATE ff_channels SET auth_state='reconnect',last_error=? WHERE id=?",'授权刷新失败，需要管理员重新连接。',cid);throw error;}
}
export async function google(env:Env,cid:string,type:'data'|'analytics'|'reporting',endpoint:string,params:Record<string,any>={},body?:any){
  const root=type==='data'?DATA:type==='analytics'?ANALYTICS:REPORTING;
  const query=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>[k,String(v)]));
  const url=root+(type==='analytics'?'':endpoint)+(query.size?'?'+query:'');
  for(let attempt=0;attempt<2;attempt++){
    try{return await json(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+await access(env,cid,attempt>0),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
    catch(error){if(!(error instanceof GoogleError)||error.status!==401||attempt)throw error;}
  }
}
export async function reportingList(env:Env,cid:string,endpoint:string,field:string){
  const output:Row[]=[];let page='';const seen=new Set();
  do{const response=await google(env,cid,'reporting',endpoint,{pageSize:100,pageToken:page});output.push(...response[field]||[]);page=response.nextPageToken||'';if(page&&seen.has(page))throw new AppError(502,'Reporting 分页重复，请重试。');seen.add(page);}while(page);
  return output;
}
export async function download(env:Env,cid:string,url:string){
  const u=new URL(url);if(u.protocol!=='https:'||!['youtubereporting.googleapis.com','www.googleapis.com'].includes(u.hostname)||u.username||u.password||u.port)throw new AppError(400,'报表下载地址不是受支持的 Google 官方地址。');
  const response=await http(url,{headers:{Authorization:'Bearer '+await access(env,cid),'Accept-Encoding':'identity'}});
  return limitedText(response.body,12_000_000);
}
