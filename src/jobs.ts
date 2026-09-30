import {Env,Row,AppError,all,one,run,batches,parse,now,digest} from './types';
import {google,reportingList,download,GoogleError,MONEY} from './google';
import {REPORTS,normalize,duration,reachCsv,verifiedRatio} from './reports';

export async function addWork(env:Env,taskId:string,kind:string,payload:Row,key:string){
  const id=await digest(taskId+':'+key);
  await run(env.DB,"INSERT OR IGNORE INTO ff_work(id,task_id,kind,payload_json,updated_at) VALUES(?,?,?,?,?)",id,taskId,kind,JSON.stringify(payload),now());
  const row=await one(env.DB,'SELECT status FROM ff_work WHERE id=?',id);
  if(row?.status!=='pending')return;
  // An unsuccessful send leaves durable work visible as pending, recoverable from the UI.
  await env.SYNC_QUEUE.send({id});
  await run(env.DB,"UPDATE ff_work SET status='queued',updated_at=? WHERE id=? AND status='pending'",now(),id);
}
export async function startTask(env:Env,cid:string,kind:string,who:string,start:string|null,end:string|null,options:Row={}){
  const active=await one(env.DB,"SELECT id FROM ff_tasks WHERE channel_id=? AND kind=? AND status IN ('queued','running') LIMIT 1",cid,kind);
  if(active)throw new AppError(409,'此频道已有同类任务，请在任务中心查看或继续。','task_exists');
  const id=crypto.randomUUID();await run(env.DB,'INSERT INTO ff_tasks(id,channel_id,kind,status,start_date,end_date,options_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,cid,kind,'queued',start,end,JSON.stringify(options),who,now(),now());
  try{await addWork(env,id,kind==='catalog'?'catalog':kind==='reach'?'reach_list':'plan',{},'start');}
  catch{await run(env.DB,"UPDATE ff_tasks SET status='partial',error=?,updated_at=? WHERE id=?",'任务已保存，但队列投递未完成。请点击继续。',now(),id);}
  return id;
}
export async function refreshTask(env:Env,id:string){
  const counts=await all(env.DB,'SELECT status,count(*) n FROM ff_work WHERE task_id=? GROUP BY status',id);
  const count=Object.fromEntries(counts.map(r=>[r.status,r.n]));
  const status=(count.pending||count.queued||count.running)?'running':(count.error||count.permission||count.waiting)?'partial':'success';
  await run(env.DB,"UPDATE ff_tasks SET status=?,updated_at=? WHERE id=? AND status!='cancelled'",status,now(),id);
}
export async function taskView(env:Env,cid?:string){
  return all(env.DB,`SELECT t.*,c.title channel_title,(SELECT count(*) FROM ff_work w WHERE w.task_id=t.id) total,(SELECT count(*) FROM ff_work w WHERE w.task_id=t.id AND w.status IN ('success','no_data')) done,(SELECT count(*) FROM ff_work w WHERE w.task_id=t.id AND w.status IN ('error','permission','waiting')) failed FROM ff_tasks t JOIN ff_channels c ON c.id=t.channel_id ${cid?'WHERE channel_id=?':''} ORDER BY t.created_at DESC LIMIT 100`,...(cid?[cid]:[]));
}
export async function retryTask(env:Env,id:string){
  const task=await one(env.DB,'SELECT * FROM ff_tasks WHERE id=?',id);if(!task)throw new AppError(404,'任务不存在。');
  const other=await one(env.DB,"SELECT id FROM ff_tasks WHERE channel_id=? AND kind=? AND id!=? AND status IN ('queued','running') LIMIT 1",task.channel_id,task.kind,id);
  if(other)throw new AppError(409,'此频道已有另一条同类任务正在执行，请先处理当前任务后再继续历史任务。');
  const work=await all(env.DB,"SELECT id FROM ff_work WHERE task_id=? AND (status IN ('error','permission','waiting','pending','queued') OR (status='running' AND lease_until<?))",id,Date.now());
  await run(env.DB,"UPDATE ff_tasks SET status='queued',error=NULL,updated_at=? WHERE id=?",now(),id);
  // Queue may expire old messages. Requeue only a bounded group; the UI can resume additional groups.
  for(const row of work.slice(0,100)){
    await run(env.DB,"UPDATE ff_work SET status='pending',attempts=0,error=NULL,lease_until=0,lease_token=NULL,updated_at=? WHERE id=?",now(),row.id);
    await env.SYNC_QUEUE.send({id:row.id});await run(env.DB,"UPDATE ff_work SET status='queued' WHERE id=? AND status='pending'",row.id);
  }
  await refreshTask(env,id);return {requeued:Math.min(work.length,100),remaining:Math.max(work.length-100,0)};
}
async function saveReport(env:Env,task:Row,work:Row,kind:string,vid:string,status:string,data:Row={},error:string|null=null,raw?:any){
  const id=await digest([task.id,vid,kind].join(':'));
  let rawKey:string|null=null;if(raw){rawKey=`reports/${task.channel_id}/${id}.json`;await env.FILES.put(rawKey,JSON.stringify(raw),{httpMetadata:{contentType:'application/json'},customMetadata:{source:'youtube_analytics',collectedAt:now()}});}
  await run(env.DB,'INSERT INTO ff_reports(id,channel_id,video_id,kind,name,start_date,end_date,source,status,data_json,raw_key,error,updated_at,task_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data_json=excluded.data_json,raw_key=COALESCE(excluded.raw_key,ff_reports.raw_key),error=excluded.error,updated_at=excluded.updated_at',id,task.channel_id,vid,kind,REPORTS[kind]?.name||kind,task.start_date,task.end_date,'analytics_api',status,JSON.stringify(data),rawKey,error,now(),task.id);
}
async function catalog(env:Env,task:Row,p:Row){
  const channel=await one(env.DB,'SELECT * FROM ff_channels WHERE id=?',task.channel_id);if(!channel?.uploads)throw new AppError(400,'频道没有可读取的视频列表，请重新授权。');
  const page=await google(env,channel.id,'data','playlistItems',{part:'contentDetails',playlistId:channel.uploads,maxResults:50,pageToken:p.page});
  const ids=[...new Set<string>((page.items||[]).map((x:Row)=>x.contentDetails?.videoId).filter(Boolean))];
  if(ids.length){
    const response=await google(env,channel.id,'data','videos',{part:'snippet,contentDetails,statistics,status',id:ids.join(','),maxResults:50});
    const statements:D1PreparedStatement[]=[];const thumbs:string[]=[];
    for(const v of response.items||[]){
      if(v.snippet.channelId!==channel.id)continue;
      const thumb=v.snippet.thumbnails?.high?.url||v.snippet.thumbnails?.medium?.url||v.snippet.thumbnails?.default?.url||'';
      const safe=/^https:\/\/(i\.ytimg\.com|img\.youtube\.com)\//.test(thumb)?thumb:'';
      statements.push(env.DB.prepare('INSERT INTO ff_videos(channel_id,id,title,published_at,duration,lifetime_views,thumbnail_url,metadata_json,observed_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,id) DO UPDATE SET title=excluded.title,published_at=excluded.published_at,duration=excluded.duration,lifetime_views=excluded.lifetime_views,thumbnail_url=excluded.thumbnail_url,metadata_json=excluded.metadata_json,observed_at=excluded.observed_at').bind(channel.id,v.id,v.snippet.title,v.snippet.publishedAt||'',duration(v.contentDetails?.duration),v.statistics?.viewCount==null?null:Number(v.statistics.viewCount),safe,JSON.stringify(v),now()));
      if(safe)thumbs.push(v.id);
    }
    await batches(env.DB,statements);
    for(let i=0;i<thumbs.length;i+=5)await addWork(env,task.id,'thumbnails',{ids:thumbs.slice(i,i+5)},`thumb:${p.page||'first'}:${i}`);
  }
  const count=await one(env.DB,'SELECT count(*) n FROM ff_videos WHERE channel_id=?',channel.id);
  await run(env.DB,'UPDATE ff_tasks SET note=?,updated_at=? WHERE id=?',`已保存 ${count?.n||0} 条视频，缩略图分别入库。`,now(),task.id);
  if(page.nextPageToken){if(page.nextPageToken===p.page)throw new AppError(502,'视频目录分页没有前进。');await addWork(env,task.id,'catalog',{page:page.nextPageToken},'page:'+page.nextPageToken);}
  else await run(env.DB,'UPDATE ff_channels SET synced_at=? WHERE id=?',now(),channel.id);
}
async function imageBytes(response:Response){const chunks:Uint8Array[]=[];let count=0;const reader=response.body!.getReader();try{for(;;){const {value,done}=await reader.read();if(done)break;count+=value.length;if(count>2_000_000){await reader.cancel();throw new AppError(413,'缩略图大于 2 MB。');}chunks.push(value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(count);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length;}return bytes;}
async function thumbnails(env:Env,task:Row,p:Row){
  let failures=0;
  for(const id of p.ids){
    const video=await one(env.DB,'SELECT thumbnail_url FROM ff_videos WHERE channel_id=? AND id=?',task.channel_id,id);if(!video?.thumbnail_url)continue;
    try{
      const u=new URL(video.thumbnail_url);if(u.protocol!=='https:'||!['i.ytimg.com','img.youtube.com'].includes(u.hostname)||u.username||u.password||u.port)throw new Error('invalid thumbnail');
      const response=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('download');
      const mime=response.headers.get('Content-Type')?.split(';')[0]||'';if(!['image/jpeg','image/png','image/webp'].includes(mime))throw new Error('invalid type');
      const key=`thumbnails/${task.channel_id}/${id}`;await env.FILES.put(key,await imageBytes(response),{httpMetadata:{contentType:mime},customMetadata:{source:'youtube_data',collectedAt:now()}});
      await run(env.DB,"UPDATE ff_videos SET thumbnail_key=?,thumbnail_status='saved' WHERE channel_id=? AND id=?",key,task.channel_id,id);
    }catch{failures++;await run(env.DB,"UPDATE ff_videos SET thumbnail_status='error' WHERE channel_id=? AND id=?",task.channel_id,id);}
  }
  if(failures)throw new GoogleError(502,`${failures} 张缩略图保存失败，可单独重试此步骤。`,true);
}
async function plan(env:Env,task:Row,p:Row){
  const options=parse(task.options_json);const types:string[]=options.reports;
  if(!p.cursor){for(const kind of types.filter(k=>!k.startsWith('retention')))await addWork(env,task.id,'analytics',{kind,vid:''},'channel:'+kind);}
  let videos:Row[]=[];let next:any=null;
  if(Array.isArray(options.video_ids)&&options.video_ids.length){const offset=Number(p.cursor||0);const ids=options.video_ids.slice(offset,offset+5);videos=ids.map((id:string)=>({id}));if(offset+5<options.video_ids.length)next=offset+5;}
  else{videos=await all(env.DB,'SELECT id FROM ff_videos WHERE channel_id=? AND id>? ORDER BY id LIMIT 5',task.channel_id,String(p.cursor||''));if(videos.length===5)next=videos.at(-1)!.id;}
  for(const v of videos)for(const kind of types)await addWork(env,task.id,'analytics',{kind,vid:v.id},v.id+':'+kind);
  if(next!==null)await addWork(env,task.id,'plan',{cursor:next},'plan:'+next);
  await run(env.DB,'UPDATE ff_tasks SET note=?,updated_at=? WHERE id=?','正在按视频分批采集；每份报表独立保存。',now(),task.id);
}
async function analytics(env:Env,task:Row,work:Row,p:Row){
  if(!Object.hasOwn(REPORTS,p.kind))throw new AppError(400,'不支持的报表。');const def=REPORTS[p.kind];
  if(def.money){const channel=await one(env.DB,'SELECT scopes_json FROM ff_channels WHERE id=?',task.channel_id);if(!parse<string[]>(channel?.scopes_json,[]).includes(MONEY)){await saveReport(env,task,work,p.kind,p.vid,'permission',{},'缺少收入只读授权，请管理员重新连接并勾选收入权限。');return 'permission';}}
  const filters=[p.vid?`video==${p.vid}`:'',def.filters||''].filter(Boolean).join(';');
  const params:Row={ids:`channel==${task.channel_id}`,startDate:task.start_date,endDate:task.end_date,metrics:def.metrics,dimensions:def.dimension,filters,maxResults:200,...(def.money?{currency:'USD'}:{})};
  let columns:any[]=[];const rows:any[]=[];let previous='';
  for(let index=1;index<=10001;index+=200){
    const current=await one(env.DB,'SELECT status FROM ff_tasks WHERE id=?',task.id);if(current?.status==='cancelled')return 'cancelled';
    const response=await google(env,task.channel_id,'analytics','',{...params,startIndex:index});
    if(index===1)columns=response.columnHeaders||[];
    else if(JSON.stringify(columns)!==JSON.stringify(response.columnHeaders||[]))throw new AppError(502,'报表分页列不一致，尚未保存为完整报表。');
    const batch=response.rows||[];const marker=JSON.stringify(batch);if(batch.length&&marker===previous)throw new AppError(502,'报表分页重复，尚未保存为完整报表。');previous=marker;rows.push(...batch);
    if(rows.length>10000)throw new AppError(413,'单份报表超过 10000 行，请缩短日期范围后采集。');
    if(batch.length<200)break;
  }
  const raw={columnHeaders:columns,rows,query:params};const data=normalize(raw,p.kind);
  if(new TextEncoder().encode(JSON.stringify(data)).byteLength>1_000_000)throw new AppError(413,'此报表过大，请缩短日期范围。');
  const status=rows.length?'success':'no_data';await saveReport(env,task,work,p.kind,p.vid,status,data,null,raw);return status;
}
function reportDay(report:Row){const start=new Date(report.startTime),end=new Date(report.endTime);const hours=(+end-+start)/3600000;const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(start);const val=Object.fromEntries(parts.map(x=>[x.type,x.value]));if(hours<23||hours>25||val.hour!=='00'||val.minute!=='00')throw new AppError(400,'覆盖面日报不符合太平洋时间单日口径。');return `${val.year}-${val.month}-${val.day}`;}
async function reachList(env:Env,task:Row){
  const cid=task.channel_id;let channel=await one(env.DB,'SELECT * FROM ff_channels WHERE id=?',cid);let job=channel?.reach_job;
  if(!job){
    const types=await reportingList(env,cid,'reportTypes','reportTypes');if(!types.some(r=>r.id==='channel_reach_basic_a1'))throw new AppError(403,'当前频道未提供覆盖面日报类型，请核对资格或使用 Studio 导出。');
    const jobs=await reportingList(env,cid,'jobs','jobs');let found=jobs.find(j=>j.reportTypeId==='channel_reach_basic_a1'&&!j.expireTime);
    if(!found)found=await google(env,cid,'reporting','jobs',{}, {reportTypeId:'channel_reach_basic_a1',name:'飞凡内部数据平台 · 覆盖面'});
    job=found!.id;await run(env.DB,'UPDATE ff_channels SET reach_job=? WHERE id=?',job,cid);
  }
  const reports=await reportingList(env,cid,`jobs/${encodeURIComponent(job)}/reports`,'reports');const latest=new Map<string,Row>();
  for(const r of reports){const day=reportDay(r);if(task.start_date&&day<task.start_date||task.end_date&&day>task.end_date)continue;if(!latest.has(day)||latest.get(day)!.createTime<r.createTime)latest.set(day,r);}
  for(const [day,report] of latest){const old=await one(env.DB,'SELECT report_id FROM ff_reach_days WHERE channel_id=? AND day=?',cid,day);if(old?.report_id!==report.id)await addWork(env,task.id,'reach_file',{day,report},'reach:'+day+':'+report.id);}
  const note=latest.size?`找到 ${latest.size} 天覆盖面日报；未覆盖日期不会按零处理。`:'Google 尚未生成所选日期的日报。新任务通常需要等待，可稍后点继续检查。';
  await run(env.DB,'UPDATE ff_tasks SET note=?,updated_at=? WHERE id=?',note,now(),task.id);return latest.size?'success':'waiting';
}
async function reachFile(env:Env,task:Row,p:Row){
  const old=await one(env.DB,'SELECT created_at FROM ff_reach_days WHERE channel_id=? AND day=?',task.channel_id,p.day);if(old&&old.created_at>p.report.createTime)return 'success';
  const raw=await download(env,task.channel_id,p.report.downloadUrl);const rows=reachCsv(raw,task.channel_id,p.day);const key=`reach/${task.channel_id}/${await digest(p.report.id)}.csv`;
  await env.FILES.put(key,raw,{httpMetadata:{contentType:'text/csv;charset=utf-8'},customMetadata:{source:'youtube_reporting',collectedAt:now()}});
  // Keep the date unpublished until its entire replacement is committed. Reads only join published dates.
  await run(env.DB,'DELETE FROM ff_reach_days WHERE channel_id=? AND day=?',task.channel_id,p.day);
  await run(env.DB,'DELETE FROM ff_reach WHERE channel_id=? AND day=?',task.channel_id,p.day);
  await batches(env.DB,rows.map(r=>env.DB.prepare('INSERT INTO ff_reach(channel_id,video_id,day,impressions,ctr_raw,report_id) VALUES(?,?,?,?,?,?)').bind(task.channel_id,r.video_id,p.day,r.impressions,r.ctr_raw,p.report.id)));
  await run(env.DB,'INSERT INTO ff_reach_days(channel_id,day,report_id,created_at,raw_key,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id,day) DO UPDATE SET report_id=excluded.report_id,created_at=excluded.created_at,raw_key=excluded.raw_key,updated_at=excluded.updated_at',task.channel_id,p.day,p.report.id,p.report.createTime,key,now());
  if(verifiedRatio(rows))await run(env.DB,"UPDATE ff_channels SET ctr_unit='ratio',ctr_unit_source='verified_api_ratio' WHERE id=? AND ctr_unit='unknown'",task.channel_id);
  return 'success';
}
export async function consume(env:Env,batch:MessageBatch<{id:string}>){
  for(const message of batch.messages){
    const work=await one(env.DB,'SELECT * FROM ff_work WHERE id=?',message.body.id);if(!work||!['pending','queued','running'].includes(work.status)){message.ack();continue;}
    const task=await one(env.DB,'SELECT * FROM ff_tasks WHERE id=?',work.task_id);if(!task||task.status==='cancelled'){message.ack();continue;}
    const lease=crypto.randomUUID();const claim=await run(env.DB,"UPDATE ff_work SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=? AND (status IN ('queued','pending') OR (status='running' AND lease_until<?))",lease,Date.now()+900000,now(),work.id,Date.now());
    if(!claim.meta.changes){message.retry({delaySeconds:120});continue;}
    await run(env.DB,"UPDATE ff_tasks SET status='running',updated_at=?,error=NULL WHERE id=? AND status!='cancelled'",now(),task.id);
    const p=parse(work.payload_json);
    try{
      let status='success';
      if(work.kind==='catalog')await catalog(env,task,p);
      else if(work.kind==='thumbnails')await thumbnails(env,task,p);
      else if(work.kind==='plan')await plan(env,task,p);
      else if(work.kind==='analytics')status=await analytics(env,task,work,p);
      else if(work.kind==='reach_list')status=await reachList(env,task);
      else if(work.kind==='reach_file')status=await reachFile(env,task,p);
      else throw new AppError(400,'未知任务类型。');
      await run(env.DB,'UPDATE ff_work SET status=?,lease_until=0,lease_token=NULL,error=NULL,updated_at=? WHERE id=? AND lease_token=?',status,now(),work.id,lease);message.ack();
    }catch(error){
      const detail=error instanceof AppError?error.message:'此步骤执行失败，已保存进度。请重试或查看 Cloudflare 日志。';
      const retry=error instanceof GoogleError&&error.retryable&&work.attempts<2;
      const status=retry?'queued':error instanceof AppError&&error.status===403?'permission':'error';
      await run(env.DB,'UPDATE ff_work SET status=?,error=?,lease_until=0,lease_token=NULL,updated_at=? WHERE id=? AND lease_token=?',status,detail,now(),work.id,lease);
      await run(env.DB,'UPDATE ff_tasks SET error=?,updated_at=? WHERE id=?',detail,now(),task.id);
      if(!retry&&work.kind==='analytics')await saveReport(env,task,work,p.kind,p.vid,status,{},detail);
      if(retry)message.retry({delaySeconds:Math.min(600,60*2**work.attempts)});else message.ack();
    }
    await refreshTask(env,task.id);
  }
}
