import {ensureLibrary,lifetimePeriod} from './library';
import {initialized,databaseFailure} from './database';
import schema from './schema.sql';
import {Env,Person,Row,AppError,all,one,run,batches,parse,now,allowed,admin,capability,isAdmin,dates,textValue,videoId,channelId} from './types';
import {person,mutation,readJson,audit,local,configMissing} from './security';
import {saveClient,begin,finish,MONEY} from './google';
import {REPORTS,canReport,studio,csvExport} from './reports';
import {startTask,taskView,retryTask,consume} from './jobs';

const securityHeaders={
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()', 'Cache-Control':'no-store'
};
function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=utf-8',...securityHeaders}});}
function file(data:BodyInit|null,type:string,name?:string){return new Response(data,{headers:{'Content-Type':type,...securityHeaders,...(name?{'Content-Disposition':`attachment; filename="${name}"`}:{})}});}
async function channels(env:Env,p:Person){
  const items=await all(env.DB,`SELECT id,title,auth_state,connected_at,synced_at,scopes_json,ctr_unit,ctr_unit_source,last_error,(SELECT count(*) FROM ff_visible_videos v WHERE v.channel_id=c.id) video_count,(SELECT count(*) FROM ff_visible_videos v WHERE v.channel_id=c.id AND thumbnail_status='saved') thumbnail_count,(SELECT count(DISTINCT video_id) FROM ff_visible_reports r WHERE r.channel_id=c.id AND r.kind='retention' AND r.status='success') retention_count FROM ff_channels c ORDER BY title`);
  return items.filter(c=>isAdmin(p)||p.channels.includes(c.id)).map(c=>({id:c.id,title:c.title,auth_state:c.auth_state,connected_at:c.connected_at,synced_at:c.synced_at,video_count:c.video_count,thumbnail_count:c.thumbnail_count,retention_count:c.retention_count,...(isAdmin(p)?{monetary:parse<string[]>(c.scopes_json,[]).includes(MONEY),ctr_unit:c.ctr_unit,ctr_unit_source:c.ctr_unit_source,last_error:c.last_error}:{})}));
}
function exposeReport(r:Row,p:Person){
  const value=parse(r.data_json);const data=r.kind==='studio_retention'&&!isAdmin(p)?{dataset:value.dataset}:value;
  return {id:r.id,kind:r.kind,name:r.name,start_date:r.start_date,end_date:r.end_date,source:r.source,status:r.status,data,error:r.error,updated_at:r.updated_at};
}
async function reportRows(env:Env,p:Person,cid:string,vid:string,start?:string,end?:string){
  allowed(p,cid);
  const rows=await all(env.DB,`SELECT * FROM ff_visible_reports WHERE channel_id=? AND video_id=? ${start&&end?'AND start_date=? AND end_date=?':''} ORDER BY updated_at DESC LIMIT 500`,cid,vid,...(start&&end?[start,end]:[]));
  const seen=new Set();return rows.filter(r=>canReport(p,r.kind)).filter(r=>{const key=[r.kind,r.start_date,r.end_date,r.source,r.source==='studio_csv'?r.id:''].join(':');if(seen.has(key))return false;seen.add(key);return true;}).map(r=>exposeReport(r,p));
}
async function reach(env:Env,cid:string,start:string,end:string,vid?:string){
  const channel=await one(env.DB,'SELECT ctr_unit,ctr_unit_source FROM ff_channels WHERE id=?',cid);
  const days=await one(env.DB,'SELECT count(*) n,min(day) first,max(day) last FROM ff_reach_days WHERE channel_id=? AND day BETWEEN ? AND ?',cid,start,end);
  const rows=await all(env.DB,`SELECT r.day,sum(impressions) impressions,CASE WHEN sum(CASE WHEN impressions>0 AND ctr_raw IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE sum(impressions*ctr_raw)/NULLIF(sum(impressions),0) END ctr_raw FROM ff_reach r JOIN ff_reach_days d ON r.channel_id=d.channel_id AND r.day=d.day AND r.report_id=d.report_id WHERE NOT EXISTS(SELECT 1 FROM ff_video_trash t WHERE t.channel_id=r.channel_id AND t.video_id=r.video_id) AND r.channel_id=? AND r.day BETWEEN ? AND ? ${vid?'AND video_id=?':''} GROUP BY r.day ORDER BY r.day`,cid,start,end,...(vid?[vid]:[]));
  const unit=channel?.ctr_unit||'unknown';const factor=unit==='ratio'?100:unit==='percent'?1:null;
  const expected=Math.round((Date.parse(end)-Date.parse(start))/86400000)+1;
  const impressions=rows.reduce((n,r)=>n+r.impressions,0);
  const ctr=factor!==null&&impressions>0&&rows.every(r=>!r.impressions||r.ctr_raw!==null)?rows.reduce((n,r)=>n+r.impressions*(r.ctr_raw||0),0)/impressions*factor:null;
  return {unit,unit_source:channel?.ctr_unit_source,expected_days:expected,covered_days:days?.n||0,complete:days?.n===expected,first_day:days?.first,last_day:days?.last,covered_impressions:rows.length?impressions:null,covered_ctr:ctr,rows:rows.map(r=>({day:r.day,impressions:r.impressions,ctr_pct:factor!==null&&r.ctr_raw!==null?r.ctr_raw*factor:null})),note:'仅按已覆盖日报计算；CTR 按展示量加权，原始精度可能造成细微差异。单位未确认时不显示百分比。'};
}
function taskManage(p:Person,t:Row){allowed(p,t.channel_id);capability(p,'sync');if(t.kind==='reach')capability(p,'ctr');if((parse(t.options_json).reports||[]).some((k:string)=>REPORTS[k]?.money))capability(p,'revenue');}
function safeTask(t:Row){const {options_json,...rest}=t;return rest;}
async function handle(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);const path=url.pathname;const method=request.method;
  if(path==='/api/health')return json({name:'飞凡内部数据平台',version:'0.1.0',ok:true});
  if(!path.startsWith('/api/')&&!path.startsWith('/oauth/')){
    const response=await env.ASSETS.fetch(request);const headers=new Headers(response.headers);for(const [k,v] of Object.entries(securityHeaders))headers.set(k,v);return new Response(response.body,{status:response.status,headers});
  }
  const p=await person(request,env);
  if(!['GET','HEAD'].includes(method))mutation(request);
  if(path==='/api/me'&&method==='GET'){
    const ready=await initialized(env);return json({user:p,initialized:ready,local:local(request,env),missing:isAdmin(p)?configMissing(env).filter(k=>!(local(request,env)&&k.startsWith('ACCESS_'))):[],channels:ready?await channels(env,p):[],reports:Object.entries(REPORTS).filter(([k])=>canReport(p,k)).map(([key,v])=>({key,...v})),version:'0.1.0'});
  }
  if(path==='/api/setup'&&method==='POST'){
    if(!p.owner)throw new AppError(403,'只有 OWNER_EMAIL 指定的管理员可以初始化。');
    if(!env.DB||!env.FILES||!env.SYNC_QUEUE)throw new AppError(503,'请先完成 D1、R2、Queues 绑定。');
    const previous=await one(env.DB,"SELECT name FROM sqlite_master WHERE type='table' AND name='ff_meta'");
    if(previous){const version=await one(env.DB,"SELECT value FROM ff_meta WHERE key='schema_version'");if(version?.value&&version.value!=='1')throw new AppError(409,'数据库版本与程序不一致，停止初始化以保护数据。');}
    await batches(env.DB,schema.split(';').map(s=>s.trim()).filter(Boolean).map(s=>env.DB.prepare(s)));
    await audit(env,p.email,'setup','schema-v1');return json({ok:true});
  }
  if(!await initialized(env))throw new AppError(503,'数据库尚未初始化，请管理员完成首次设置。','initialize_required');
  if(path==='/oauth/callback'&&method==='GET'){
    admin(p);try{const result=await finish(env,p.email,p.subject,url.searchParams);await audit(env,p.email,'connect',`${result.length} channels`);return Response.redirect(url.origin+'/#settings?connected=1',303);}catch(error){const msg=error instanceof AppError?error.message:'授权未完成，请重试。';return Response.redirect(url.origin+'/#settings?error='+encodeURIComponent(msg),303);}
  }
  if(path==='/api/settings'&&method==='GET'){
    admin(p);const configured=!!await one(env.DB,"SELECT key FROM ff_settings WHERE key='google_client'");return json({google_configured:configured,callback:(env.PUBLIC_URL||url.origin).replace(/\/$/,'')+'/oauth/callback',missing:configMissing(env).filter(k=>!(local(request,env)&&k.startsWith('ACCESS_'))),channels:await channels(env,p)});
  }
  if(path==='/api/settings/google'&&method==='POST'){admin(p);await saveClient(env,await readJson(request));await audit(env,p.email,'configure','google-oauth');return json({ok:true});}
  if(path==='/api/oauth/begin'&&method==='POST'){admin(p);const body=await readJson(request);return json({url:await begin(env,p.email,p.subject,url.origin,body.monetary===true)});}
  if(path==='/api/channels'&&method==='GET')return json({items:await channels(env,p)});
  const unitMatch=path.match(/^\/api\/channels\/(UC[\w-]{22})\/ctr-unit$/);
  if(unitMatch&&method==='POST'){admin(p);const body=await readJson(request);if(!['ratio','percent','unknown'].includes(body.unit))throw new AppError(400,'CTR 单位无效。');await run(env.DB,"UPDATE ff_channels SET ctr_unit=?,ctr_unit_source='admin_verified' WHERE id=?",body.unit,unitMatch[1]);await audit(env,p.email,'ctr-unit',unitMatch[1]);return json({ok:true});}
  if(path==='/api/videos'&&method==='GET'){
    const cid=channelId(url.searchParams.get('channel')||'');allowed(p,cid);
    const page=Math.max(1,Math.min(10000,Number(url.searchParams.get('page'))||1)),size=24;const q=textValue(url.searchParams.get('q'),100);
    const sort=url.searchParams.get('sort')==='published'?'published_at DESC,id':'lifetime_views DESC,id';
    const where='channel_id=?'+(q?' AND (title LIKE ? ESCAPE \'\\\' OR tags LIKE ? ESCAPE \'\\\')':'');
    const escaped='%'+q.replace(/[\\%_]/g,'\\$&')+'%';const args=q?[cid,escaped,escaped]:[cid];
    const count=await one(env.DB,'SELECT count(*) n FROM ff_visible_videos WHERE '+where,...args);
    const items=await all(env.DB,`SELECT channel_id,id,title,published_at,duration,lifetime_views,thumbnail_status,observed_at,tags,(SELECT max(updated_at) FROM ff_visible_reports r WHERE r.channel_id=v.channel_id AND r.video_id=v.id AND kind='retention' AND status='success') retention_at FROM ff_visible_videos v WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`,...args,size,(page-1)*size);
    return json({items,total:count?.n||0,page,pages:Math.ceil((count?.n||0)/size)});
  }
  const videoMatch=path.match(/^\/api\/videos\/(UC[\w-]{22})\/([\w-]{11})$/);
  if(videoMatch){
    const [,cid,vid]=videoMatch;allowed(p,cid);const v=await one(env.DB,'SELECT channel_id,id,title,published_at,duration,lifetime_views,thumbnail_status,observed_at,notes,tags FROM ff_visible_videos WHERE channel_id=? AND id=?',cid,vid);if(!v)throw new AppError(404,'视频尚未同步，请先同步频道视频库。');
    if(method==='GET'){
      const start=url.searchParams.get('start')||undefined,end=url.searchParams.get('end')||undefined;if(start||end)dates(start,end);
      return json({video:v,reports:await reportRows(env,p,cid,vid,start,end),...(start&&end&&(isAdmin(p)||p.permissions.ctr)?{reach:await reach(env,cid,start,end,vid)}:{})});
    }
    if(method==='POST'){const body=await readJson(request);await run(env.DB,'UPDATE ff_videos SET notes=?,tags=? WHERE channel_id=? AND id=?',textValue(body.notes,10000),textValue(body.tags,500),cid,vid);await audit(env,p.email,'edit-notes',cid+'/'+vid);return json({ok:true});}
  }
  const imageMatch=path.match(/^\/api\/thumbnails\/(UC[\w-]{22})\/([\w-]{11})$/);
  if(imageMatch&&method==='GET'){
    allowed(p,imageMatch[1]);const v=await one(env.DB,'SELECT thumbnail_key FROM ff_visible_videos WHERE channel_id=? AND id=?',imageMatch[1],imageMatch[2]);const object=v?.thumbnail_key?await env.FILES.get(v.thumbnail_key):null;if(!object)throw new AppError(404,'缩略图尚未保存。');return file(object.body,object.httpMetadata?.contentType||'image/jpeg');
  }
  const createMatch=path.match(/^\/api\/channels\/(UC[\w-]{22})\/tasks$/);
  if(createMatch&&method==='POST'){
    const cid=createMatch[1];allowed(p,cid);capability(p,'sync');if(!await one(env.DB,'SELECT id FROM ff_channels WHERE id=?',cid))throw new AppError(404,'频道不存在。');
    const b=await readJson(request);if(!['catalog','reports','reach'].includes(b.kind))throw new AppError(400,'请选择视频库、报表或覆盖面任务。');
    if(b.period!==undefined&&!['custom','lifetime'].includes(b.period))throw new AppError(400,'日期类型无效。');
    const period=b.kind==='catalog'?{start:null,end:null}:b.period==='lifetime'?await lifetimePeriod(env,cid,undefined,b.end):dates(b.start,b.end);const options:Row={period:b.period||'custom'};
    if(b.kind==='reach')capability(p,'ctr');
    if(b.kind==='reports'){
      if(!Array.isArray(b.reports)||!b.reports.length||b.reports.length>Object.keys(REPORTS).length)throw new AppError(400,'至少选择一项报表。');
      if(b.reports.some((k:any)=>typeof k!=='string'||!Object.hasOwn(REPORTS,k)||!canReport(p,k)))throw new AppError(403,'包含未获授权或未知的报表。');options.reports=[...new Set(b.reports)];
      if(b.video_ids!==undefined){if(!Array.isArray(b.video_ids)||!b.video_ids.length||b.video_ids.length>100)throw new AppError(400,'单次手选最多 100 个视频；整个频道请使用全部视频选项。');options.video_ids=[...new Set(b.video_ids.map((x:any)=>videoId(String(x))))];for(const id of options.video_ids)if(!await one(env.DB,'SELECT id FROM ff_visible_videos WHERE channel_id=? AND id=?',cid,id))throw new AppError(400,'所选视频不属于此频道或尚未同步。');}
      const count=await one(env.DB,'SELECT count(*) n FROM ff_visible_videos WHERE channel_id=?',cid);if(!count?.n)throw new AppError(400,'请先同步视频库，再采集报表。');
    }
    const id=await startTask(env,cid,b.kind,p.email,period.start,period.end,options);await audit(env,p.email,'start-task',id);return json({id},202);
  }
  if(path==='/api/trash'){
    admin(p);
    if(method==='GET')return json({items:await all(env.DB,'SELECT t.*,v.title,c.title channel_title FROM ff_video_trash t JOIN ff_videos v ON v.channel_id=t.channel_id AND v.id=t.video_id JOIN ff_channels c ON c.id=t.channel_id ORDER BY deleted_at DESC LIMIT 1000')});
    if(method==='POST'){
      const b=await readJson(request);const cid=channelId(String(b.channel_id||''));
      if(!['delete','restore'].includes(b.action)||!Array.isArray(b.video_ids)||!b.video_ids.length||b.video_ids.length>100)throw new AppError(400,'请选择 1—100 条视频和有效操作。');
      if(b.confirm!==true)throw new AppError(400,'请确认移入回收站或恢复操作。');
      const ids=[...new Set<string>(b.video_ids.map((x:any)=>videoId(String(x))))];
      for(const vid of ids)if(!await one(env.DB,'SELECT id FROM ff_videos WHERE channel_id=? AND id=?',cid,vid))throw new AppError(404,'视频不存在。');
      await batches(env.DB,ids.map(vid=>b.action==='delete'?env.DB.prepare('INSERT OR IGNORE INTO ff_video_trash(channel_id,video_id,deleted_at,deleted_by) VALUES(?,?,?,?)').bind(cid,vid,now(),p.email):env.DB.prepare('DELETE FROM ff_video_trash WHERE channel_id=? AND video_id=?').bind(cid,vid)));
      await audit(env,p.email,'trash-'+b.action,cid+':'+ids.join(','));return json({ok:true,count:ids.length});
    }
  }
  if(path==='/api/tasks'&&method==='GET'){
    const items=(url.searchParams.get('summary')==='1'?await all(env.DB,'SELECT id,channel_id,kind,status,updated_at FROM ff_tasks ORDER BY created_at DESC LIMIT 100'):await taskView(env)).filter(t=>(isAdmin(p)||p.channels.includes(t.channel_id))&&(isAdmin(p)||p.permissions.ctr||t.kind!=='reach'));return json({items:items.map(safeTask)});
  }
  const taskMatch=path.match(/^\/api\/tasks\/([\w-]+)(?:\/(retry|cancel))?$/);
  if(taskMatch){
    const task=await one(env.DB,'SELECT * FROM ff_tasks WHERE id=?',taskMatch[1]);if(!task)throw new AppError(404,'任务不存在。');allowed(p,task.channel_id);if(task.kind==='reach')capability(p,'ctr');
    if(method==='GET'){
      const work=(await all(env.DB,'SELECT id,kind,payload_json,status,attempts,error,updated_at FROM ff_work WHERE task_id=? ORDER BY updated_at DESC LIMIT 300',task.id)).filter(w=>w.kind!=='analytics'||canReport(p,parse(w.payload_json).kind)).map(w=>{const payload=parse(w.payload_json);return {id:w.id,kind:w.kind,name:REPORTS[payload.kind]?.name||({catalog:'视频目录',thumbnails:'保存缩略图',plan:'安排报表',reach_list:'检查覆盖面日报',reach_file:'保存覆盖面日报'} as Record<string,string>)[w.kind],video_id:payload.vid,day:payload.day,status:w.status,error:w.error,updated_at:w.updated_at};});return json({task:safeTask(task),items:work});
    }
    taskManage(p,task);if(method==='POST'&&taskMatch[2]==='retry')return json(await retryTask(env,task.id));
    if(method==='POST'&&taskMatch[2]==='cancel'){await run(env.DB,"UPDATE ff_tasks SET status='cancelled',updated_at=? WHERE id=?",now(),task.id);await audit(env,p.email,'cancel-task',task.id);return json({ok:true});}
  }
  if(path==='/api/compare'&&method==='GET'){
    const ids=(url.searchParams.get('channels')||'').split(',').filter(Boolean);if(ids.length<1||ids.length>6)throw new AppError(400,'请选择 1—6 个频道。');const {start,end}=dates(url.searchParams.get('start'),url.searchParams.get('end'));
    const items=[];for(const cid of ids){allowed(p,channelId(cid));const c=await one(env.DB,'SELECT id,title FROM ff_channels WHERE id=?',cid);if(!c)throw new AppError(404,'频道不存在。');items.push({...c,reports:await reportRows(env,p,cid,'',start,end),...(isAdmin(p)||p.permissions.ctr?{reach:await reach(env,cid,start,end)}:{})});}return json({start,end,items});
  }
  if(path==='/api/import'&&method==='POST'){
    admin(p);const b=await readJson(request,6_000_000);const cid=channelId(String(b.channel_id||'')),vid=videoId(String(b.video_id||''));dates(b.start,b.end);if(!await one(env.DB,'SELECT id FROM ff_visible_videos WHERE channel_id=? AND id=?',cid,vid))throw new AppError(400,'请先同步并选择正确的视频。');
    if(typeof b.text!=='string'||new TextEncoder().encode(b.text).byteLength>3_000_000)throw new AppError(413,'请导入不超过 3 MB 的 CSV。');
    const name=textValue(b.filename,120)||'Studio 导入.csv';const result=studio(b.text,name);const id=crypto.randomUUID(),key=`imports/${cid}/${id}.csv`;
    if(new TextEncoder().encode(JSON.stringify(result.data)).byteLength>1_500_000)throw new AppError(413,'解析后的报表过大，请缩短或拆分 CSV。');
    await env.FILES.put(key,b.text,{httpMetadata:{contentType:'text/csv;charset=utf-8'},customMetadata:{source:'user_studio_export',importedAt:now()}});
    await run(env.DB,'INSERT INTO ff_reports(id,channel_id,video_id,kind,name,start_date,end_date,source,status,data_json,raw_key,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,cid,vid,result.kind,name,b.start,b.end,'studio_csv',result.data.rows?.length?'success':'no_data',JSON.stringify(result.data),key,now());await audit(env,p.email,'import',id);return json({id});
  }
  const reportMatch=path.match(/^\/api\/reports\/([\w-]+)\/(csv|raw)$/);
  if(reportMatch&&method==='GET'){
    const r=await one(env.DB,'SELECT * FROM ff_visible_reports WHERE id=?',reportMatch[1]);if(!r)throw new AppError(404,'报表不存在。');allowed(p,r.channel_id);capability(p,'export');if(!canReport(p,r.kind))throw new AppError(403,'没有此报表的导出权限。');
    await audit(env,p.email,'export-report',r.id);
    if(reportMatch[2]==='raw'){admin(p);const obj=r.raw_key?await env.FILES.get(r.raw_key):null;if(!obj)throw new AppError(404,'没有原始文件。');return file(obj.body,obj.httpMetadata?.contentType||'application/octet-stream',r.id+(r.source==='studio_csv'?'.csv':'.json'));}
    const data=exposeReport(r,p).data;const rows=data.rows||data.dataset?.points||[];const columns=data.columns||Object.keys(rows[0]||{});return file(csvExport(rows,columns),'text/csv;charset=utf-8',r.id+'.csv');
  }
  const exportMatch=path.match(/^\/api\/channels\/(UC[\w-]{22})\/export$/);
  if(exportMatch&&method==='GET'){
    const cid=exportMatch[1];allowed(p,cid);capability(p,'export');await audit(env,p.email,'export-channel',cid);
    const stream=new ReadableStream({async start(controller){const encoder=new TextEncoder();const emit=(value:any)=>controller.enqueue(encoder.encode(JSON.stringify(value)+'\n'));try{
      emit({type:'manifest',format:'feifan-data-v1',channel_id:cid,exported_at:now(),note:'不含授权、视频文件或缩略图二进制；图像与原始附件在 R2。字段遵循导出者权限。'});
      let last='';for(;;){const rows=await all(env.DB,'SELECT channel_id,id,title,published_at,duration,lifetime_views,observed_at,notes,tags,thumbnail_status FROM ff_visible_videos WHERE channel_id=? AND id>? ORDER BY id LIMIT 100',cid,last);if(!rows.length)break;for(const row of rows)emit({type:'video',...row});last=rows.at(-1)!.id;}
      last='';for(;;){const rows=await all(env.DB,'SELECT * FROM ff_visible_reports WHERE channel_id=? AND id>? ORDER BY id LIMIT 40',cid,last);if(!rows.length)break;for(const r of rows)if(canReport(p,r.kind))emit({type:'report',channel_id:cid,video_id:r.video_id,...exposeReport(r,p)});last=rows.at(-1)!.id;}
      if(isAdmin(p)||p.permissions.ctr){last='';for(;;){const rows=await all(env.DB,'SELECT r.* FROM ff_reach r JOIN ff_reach_days d ON r.channel_id=d.channel_id AND r.day=d.day AND r.report_id=d.report_id WHERE NOT EXISTS(SELECT 1 FROM ff_video_trash t WHERE t.channel_id=r.channel_id AND t.video_id=r.video_id) AND r.channel_id=? AND r.day||r.video_id>? ORDER BY r.day||r.video_id LIMIT 200',cid,last);if(!rows.length)break;for(const row of rows)emit({type:'reach_raw',...row,note:'ctr_raw 的单位见频道设置，不应直接当百分数'});last=rows.at(-1)!.day+rows.at(-1)!.video_id;}}
      emit({type:'end',complete:true});controller.close();
    }catch{emit({type:'error',complete:false,message:'导出中断，请重新导出；没有 end 标记的文件不完整。'});controller.close();}}});return file(stream,'application/x-ndjson;charset=utf-8',cid+'.jsonl');
  }
  if(path==='/api/users'){
    admin(p);if(method==='GET')return json({owner_email:env.OWNER_EMAIL,items:(await all(env.DB,'SELECT * FROM ff_users ORDER BY email')).map(u=>({email:u.email,role:u.role,disabled:!!u.disabled,channels:parse(u.channels_json,[]),permissions:parse(u.permissions_json)}))});
    if(method==='POST'){
      const b=await readJson(request),email=textValue(b.email,254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new AppError(400,'请填写有效邮箱。');if(email===env.OWNER_EMAIL?.toLowerCase())throw new AppError(400,'主管理员由 Cloudflare OWNER_EMAIL 指定，不能在此修改。');
      if(!['admin','editor'].includes(b.role)||!Array.isArray(b.channels)||b.channels.length>500)throw new AppError(400,'角色或频道范围无效。');for(const cid of b.channels)if(!await one(env.DB,'SELECT id FROM ff_channels WHERE id=?',channelId(String(cid))))throw new AppError(400,'分配了不存在的频道。');
      const permission=Object.fromEntries(['ctr','revenue','sync','export'].map(k=>[k,b.permissions?.[k]===true]));
      await run(env.DB,'INSERT INTO ff_users(email,role,channels_json,permissions_json,disabled,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role,channels_json=excluded.channels_json,permissions_json=excluded.permissions_json,disabled=excluded.disabled,updated_at=excluded.updated_at',email,b.role,JSON.stringify([...new Set(b.channels)]),JSON.stringify(permission),b.disabled?1:0,now());await audit(env,p.email,'update-user',email);return json({ok:true});
    }
  }
  if(path==='/api/audit'&&method==='GET'){admin(p);return json({items:await all(env.DB,'SELECT * FROM ff_audit ORDER BY id DESC LIMIT 100')});}
  throw new AppError(404,'此功能地址不存在。');
}
export default {
  async fetch(request:Request,env:Env){try{return await handle(request,env);}catch(error){if(error instanceof AppError)return json({error:error.message,code:error.code},error.status);const db=databaseFailure(error);if(db.code==='database_quota')return json({error:db.message,code:db.code},db.status);console.error('feifan request failed',error instanceof Error?error.name:'unknown');return json({error:'服务暂时无法完成请求。请查看连接与设置、数据库绑定或 Cloudflare 运行日志。',code:'internal_error'},500);}},
  async queue(batch:MessageBatch<{id:string}>,env:Env){await consume(env,batch);}
};
