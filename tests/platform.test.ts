import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {seal,unseal} from '../src/security';
import {studio,reachCsv,verifiedRatio,normalize,canReport,csvExport} from '../src/reports';
import {consume,startTask} from '../src/jobs';
import {begin,finish,BASE_SCOPES} from '../src/google';
import {digest} from '../src/types';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';

const CID='UC'+'A'.repeat(22),OTHER='UC'+'B'.repeat(22),VID='demo0000001';
const OWNER='owner@example.test',STAFF='staff@example.test';
const KEY=Buffer.alloc(32,7).toString('base64');
let mf:Miniflare,db:any,bucket:any;
let testSigningKey:CryptoKey;let testJwk:any;
const bindings={LOCAL_DEV:'true',OWNER_EMAIL:OWNER,TOKEN_KEY:KEY,ACCESS_TEAM_DOMAIN:'feifan-tests.cloudflareaccess.com',ACCESS_AUD:'test-aud'};
async function request(path:string,body?:any,email=OWNER,origin='http://localhost'){
  return mf.dispatchFetch('http://localhost'+path,{method:body===undefined?'GET':'POST',headers:{'X-Feifan-Dev-Email':email,'X-Feifan-Request':'1','Origin':origin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function data(path:string,body?:any,email=OWNER){const response=await request(path,body,email);const raw=await response.text();assert.ok(response.headers.get('content-type')?.includes('application/json'),raw.slice(0,1400));const result:any=JSON.parse(raw);assert.equal(response.status<300,true,`${path}: ${JSON.stringify(result)}`);return result;}
const insertReport=async(id:string,kind:string,payload:any,cid=CID,vid=VID)=>db.prepare('INSERT INTO ff_reports(id,channel_id,video_id,kind,name,start_date,end_date,source,status,data_json,raw_key,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,cid,vid,kind,kind,'2026-09-01','2026-09-26',kind.startsWith('studio_')?'studio_csv':'analytics_api','success',JSON.stringify(payload),'secret-report.csv','2026-09-27T12:00:00Z').run();

before(async()=>{
  const pair=await generateKeyPair('RS256');testSigningKey=pair.privateKey;testJwk={...await exportJWK(pair.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
  const sql=(await readdir('.bundle')).find(x=>x.endsWith('.sql'))!;
  mf=new Miniflare(convertV4MiniflareOptions({name:'feifan-test',modules:[{type:'ESModule',path:resolve('.bundle/index.js')},{type:'Text',path:resolve('.bundle',sql)}],compatibilityDate:'2026-09-28',compatibilityFlags:['nodejs_compat'],bindings,d1Databases:{DB:'local-tests'},r2Buckets:{FILES:'files'},queueProducers:{SYNC_QUEUE:'test-queue'},assets:{directory:resolve('public'),binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true},assetConfig:{not_found_handling:'single-page-application'}},outboundService:async(req:any)=>new Response(JSON.stringify(new URL(req.url).hostname==='feifan-tests.cloudflareaccess.com'?{keys:[testJwk]}:{error:'blocked-in-test'}),{status:new URL(req.url).hostname==='feifan-tests.cloudflareaccess.com'?200:503,headers:{'Content-Type':'application/json'}})} as any));
  db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('FILES');
});
after(async()=>{await mf?.dispose();});

test('unconfigured D1 can be initialized by the designated owner only; repeat is safe',async()=>{
  assert.equal((await data('/api/me')).initialized,false);
  assert.equal((await request('/api/setup',{},'intruder@example.test')).status,403);
  await data('/api/setup',{});await data('/api/setup',{});
  assert.equal((await data('/api/me')).initialized,true);
  const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ff_%'").all();assert.ok(tables.results.length>=10);
});
test('production host rejects development identity headers and has no public business fallback',async()=>{
  const r=await mf.dispatchFetch('https://platform.example.com/api/me',{headers:{'X-Feifan-Dev-Email':OWNER,'Cf-Access-Authenticated-User-Email':OWNER}});assert.equal(r.status,401);
});
test('mutations reject foreign origins even with a valid local identity',async()=>{
  assert.equal((await request('/api/setup',{},OWNER,'https://attacker.example')).status,403);
});
test('production verifies Access JWT signature, issuer, audience and expiration',async()=>{
  const token=async(audience='test-aud',issuer='https://feifan-tests.cloudflareaccess.com',expires='5m')=>new SignJWT({email:OWNER}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer(issuer).setAudience(audience).setSubject('test-owner').setIssuedAt().setExpirationTime(expires).sign(testSigningKey);
  const send=async(t:string)=>mf.dispatchFetch('https://platform.example.com/api/me',{headers:{'Cf-Access-Jwt-Assertion':t}});
  assert.equal((await send(await token())).status,200);
  assert.equal((await send(await token('wrong-app'))).status,401);
  assert.equal((await send(await token('test-aud','https://other.cloudflareaccess.com'))).status,401);
  assert.equal((await send(await token('test-aud','https://feifan-tests.cloudflareaccess.com','-1m'))).status,401);
  const real=await token();assert.equal((await send(real.slice(0,-10)+'tamperedxx')).status,401);
});
test('authenticated yet uninvited employee is denied',async()=>{assert.equal((await request('/api/videos?channel='+CID,undefined,STAFF)).status,403);});
test('seed isolated fixtures and invite an employee with one channel and no sensitive permissions',async()=>{
  for(const id of [CID,OTHER])await db.prepare('INSERT INTO ff_channels(id,title,uploads,credential,scopes_json,connected_at) VALUES(?,?,?,?,?,?)').bind(id,'合成测试频道 '+id.slice(-1),'test-playlist','not-a-real-credential','[]','2026-09-27T00:00:00Z').run();
  for(const id of [CID,OTHER])await db.prepare('INSERT INTO ff_videos(channel_id,id,title,duration,lifetime_views,observed_at,thumbnail_key,thumbnail_status) VALUES(?,?,?,?,?,?,?,?)').bind(id,VID,'合成测试视频 <script>alert(1)</script>',2520,12345,'2026-09-27T00:00:00Z','thumb-test','saved').run();
  await bucket.put('thumb-test',new Uint8Array([1,2,3]),{httpMetadata:{contentType:'image/jpeg'}});await bucket.put('secret-report.csv','CTR,收入\n7.89,98765');
  await insertReport('summary-ok','summary',{columns:['views','averageViewDuration'],rows:[{views:1200,averageViewDuration:300}]});
  await insertReport('money-secret','revenue',{columns:['estimatedRevenue'],rows:[{estimatedRevenue:98765}]});
  await insertReport('unknown-secret','future_private_metric',{columns:['secret'],rows:[{secret:98765}]});
  await insertReport('csv-secret','studio_table',{columns:['CTR','收入'],rows:[{CTR:7.89,收入:98765}]});
  await insertReport('curve-ok','retention',normalize({columnHeaders:[{name:'elapsedVideoTimeRatio'},{name:'audienceWatchRatio'}],rows:[[0.01,1.2],[0.02,.81],[1,.33]]},'retention'));
  await insertReport('channel-summary','summary',{columns:['views'],rows:[{views:45678}]},CID,'');
  await insertReport('channel-money','revenue',{columns:['estimatedRevenue'],rows:[{estimatedRevenue:98765}]},CID,'');
  await data('/api/users',{email:STAFF,role:'editor',channels:[CID],permissions:{export:true},disabled:false});
});
test('staff list and direct object requests are scoped to assigned channels',async()=>{
  const list=await data('/api/channels',undefined,STAFF);assert.deepEqual(list.items.map((x:any)=>x.id),[CID]);assert.equal(JSON.stringify(list).includes('credential'),false);
  assert.equal((await request('/api/videos?channel='+OTHER,undefined,STAFF)).status,403);
  assert.equal((await request(`/api/videos/${OTHER}/${VID}`,undefined,STAFF)).status,403);
  assert.equal((await request(`/api/thumbnails/${OTHER}/${VID}`,undefined,STAFF)).status,403);
  assert.equal((await request(`/api/thumbnails/${CID}/${VID}`,undefined,STAFF)).status,200);
});
test('video detail and channel comparison omit sensitive reports, raw file keys and credentials',async()=>{
  for(const path of [`/api/videos/${CID}/${VID}`,`/api/videos/${CID}/${VID}?start=2026-09-01&end=2026-09-26`,`/api/compare?channels=${CID}&start=2026-09-01&end=2026-09-26`]){
    const result=await data(path,undefined,STAFF);const serialized=JSON.stringify(result);for(const forbidden of ['98765','money-secret','csv-secret','unknown-secret','ctr_raw','raw_key','secret-report.csv','credential'])assert.equal(serialized.includes(forbidden),false,forbidden+' leaked');
  }
  const detail=await data(`/api/videos/${CID}/${VID}`,undefined,STAFF);assert.ok(detail.reports.some((r:any)=>r.id==='curve-ok'));
});
test('export endpoints enforce the same channel, report and raw-file permissions',async()=>{
  assert.equal((await request('/api/reports/money-secret/csv',undefined,STAFF)).status,403);
  assert.equal((await request('/api/reports/csv-secret/csv',undefined,STAFF)).status,403);
  assert.equal((await request('/api/reports/summary-ok/raw',undefined,STAFF)).status,403);
  const response=await request(`/api/channels/${CID}/export`,undefined,STAFF);assert.equal(response.status,200);const text=await response.text();assert.ok(text.includes('"type":"end","complete":true'));assert.ok(text.includes('summary-ok'));assert.equal(text.includes('98765'),false);assert.equal(text.includes('credential'),false);
});
test('staff can edit notes without receiving YouTube write or administrative capability',async()=>{
  await data(`/api/videos/${CID}/${VID}`,{notes:'12:30 有反转',tags:'节奏'},STAFF);
  assert.equal((await data(`/api/videos/${CID}/${VID}`,undefined,STAFF)).video.notes,'12:30 有反转');
  assert.equal((await request('/api/users',{},STAFF)).status,403);
  assert.equal((await request('/api/settings',undefined,STAFF)).status,403);
  assert.equal((await request(`/api/channels/${CID}/tasks`,{kind:'reach',start:'2026-09-01',end:'2026-09-26'},STAFF)).status,403);
});
test('revoked employee is denied immediately even with the same authentication session',async()=>{
  await data('/api/users',{email:STAFF,role:'editor',channels:[CID],permissions:{export:true},disabled:true});assert.equal((await request('/api/me',undefined,STAFF)).status,403);
  await data('/api/users',{email:STAFF,role:'editor',channels:[CID],permissions:{export:true,sync:true},disabled:false});
});
test('staff with sync permission cannot request monetary or CTR jobs',async()=>{
  assert.equal((await request(`/api/channels/${CID}/tasks`,{kind:'reports',reports:['revenue'],start:'2026-09-01',end:'2026-09-26',video_ids:[VID]},STAFF)).status,403);
  assert.equal((await request(`/api/channels/${CID}/tasks`,{kind:'reach',start:'2026-09-01',end:'2026-09-26'},STAFF)).status,403);
});
test('CSV imports require a bound existing video and maintain separate provenance',async()=>{
  const csv='在视频中的位置 (%),绝对观众黏度 (%)\n0,105\n50,42.4\n100,30';
  const r=await data('/api/import',{channel_id:CID,video_id:VID,start:'2026-09-01',end:'2026-09-26',filename:'全部.csv',text:csv});
  const owner=await data(`/api/videos/${CID}/${VID}`);const imported=owner.reports.find((x:any)=>x.id===r.id);assert.equal(imported.source,'studio_csv');assert.equal(imported.data.dataset.position_basis,'studio_export_label');assert.equal(imported.data.dataset.points[0].retention_pct,105);
  assert.equal((await request('/api/import',{channel_id:CID,video_id:'nonexist001',start:'2026-09-01',end:'2026-09-26',filename:'x.csv',text:csv})).status,400);
});
test('task restart finds persisted pending work and prevents unauthorized task management',async()=>{
  const task='persisted-task';await db.prepare('INSERT INTO ff_tasks(id,channel_id,kind,status,start_date,end_date,options_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(task,CID,'reports','partial','2026-09-01','2026-09-26','{"reports":["revenue"]}',OWNER,'2026-09-27','2026-09-27').run();
  await db.prepare('INSERT INTO ff_work(id,task_id,kind,payload_json,status,updated_at) VALUES(?,?,?,?,?,?)').bind('work-persisted',task,'analytics','{"kind":"revenue","vid":"'+VID+'"}','error','2026-09-27').run();
  assert.equal((await request(`/api/tasks/${task}/retry`,{},STAFF)).status,403);
  const r=await data(`/api/tasks/${task}/retry`,{});assert.equal(r.requeued,1);assert.equal((await db.prepare('SELECT status FROM ff_work WHERE id=?').bind('work-persisted').first()).status,'queued');
});
test('queue consumer is idempotent on duplicate delivery and records missing revenue permission',async()=>{
  const env:any={DB:db,FILES:bucket,SYNC_QUEUE:{send:async()=>{}},...bindings};let acks=0;
  const batch:any={messages:[{body:{id:'work-persisted'},ack:()=>acks++,retry:()=>assert.fail('no retry for missing permission')}]};
  await consume(env,batch);await consume(env,batch);assert.equal(acks,2);
  const rows=await db.prepare("SELECT status FROM ff_reports WHERE task_id='persisted-task'").all();assert.equal(rows.results.length,1);assert.equal(rows.results[0].status,'permission');
});
test('reach only exposes fully published dates and never treats an incomplete date window as complete',async()=>{
  await db.prepare("INSERT INTO ff_reach(channel_id,video_id,day,impressions,ctr_raw,report_id) VALUES(?,?,?,?,?,?)").bind(CID,VID,'2026-09-01',100,.05,'reach-test').run();
  let r=await data(`/api/videos/${CID}/${VID}?start=2026-09-01&end=2026-09-26`);assert.equal(r.reach.covered_days,0);assert.equal(r.reach.covered_ctr,null);
  await db.prepare('INSERT INTO ff_reach_days(channel_id,day,report_id,created_at,raw_key,updated_at) VALUES(?,?,?,?,?,?)').bind(CID,'2026-09-01','reach-test','2026-09-02','reach.csv','2026-09-02').run();
  await data(`/api/channels/${CID}/ctr-unit`,{unit:'ratio'});r=await data(`/api/videos/${CID}/${VID}?start=2026-09-01&end=2026-09-26`);assert.equal(r.reach.covered_days,1);assert.equal(r.reach.complete,false);assert.equal(r.reach.covered_ctr,5);
});
test('AES-GCM protects secrets and is bound to the correct channel label',async()=>{
  const env:any={TOKEN_KEY:KEY};const enc=await seal(env,{refresh_token:'synthetic-only'},CID);assert.equal(enc.includes('synthetic'),false);assert.equal((await unseal(env,enc,CID)).refresh_token,'synthetic-only');await assert.rejects(()=>unseal(env,enc,OTHER));await assert.rejects(()=>unseal({TOKEN_KEY:Buffer.alloc(32,9).toString('base64')} as any,enc,CID));
});
test('retention units, duplicate CSV positions, formulas and ambiguous CTR are handled',()=>{
  const curve=normalize({columnHeaders:[{name:'elapsedVideoTimeRatio'},{name:'audienceWatchRatio'}],rows:[[.01,1.15]]},'retention').dataset;assert.equal(curve.points[0].position_pct,1);assert.ok(Math.abs(curve.points[0].retention_pct-115)<1e-10);assert.equal(curve.position_basis,'exclusive_interval_end');
  assert.throws(()=>studio('在视频中的位置 (%),绝对观众黏度 (%)\n50,40\n50,41','x.csv'));
  assert.ok(csvExport([{title:'=HYPERLINK("bad")'}],['title']).includes("'="));
  assert.equal(verifiedRatio([{impressions:100,ctr_raw:.05}]),false);
  assert.throws(()=>reachCsv('date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n20260902,'+CID+','+VID+',100,0.05',CID,'2026-09-01'));
  const p:any={role:'editor',permissions:{}};assert.equal(canReport(p,'future_metric'),false);assert.equal(canReport(p,'revenue'),false);assert.equal(canReport(p,'retention'),true);
});
test('Cloudflare static files are served with browser security headers',async()=>{
  const r=await request('/');assert.equal(r.status,200);assert.ok((await r.text()).includes('飞凡内部数据平台'));assert.ok(r.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
});

test('OAuth checks PKCE, binds one-time state to the owner, and paginates past ten channels',async()=>{
  await data('/api/settings/google',{web:{client_id:'fixture.apps.googleusercontent.com',client_secret:'fixture-only'}});
  const env:any={DB:db,FILES:bucket,...bindings};
  const url=new URL(await begin(env,OWNER,'oauth-owner','http://localhost:8890',false));
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('access_type'),'offline');
  const query=new URLSearchParams({state:url.searchParams.get('state')!,code:'fixture-code'});
  await assert.rejects(()=>finish(env,OWNER,'different-person',query));
  let pages=0;const original=globalThis.fetch;
  globalThis.fetch=async(input:any,init:any)=>{
    const u=new URL(String(input));let result:any;
    if(u.hostname==='oauth2.googleapis.com'){
      const values=new URLSearchParams(init.body);const verifier=values.get('code_verifier')!;
      const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');assert.equal(challenge,url.searchParams.get('code_challenge'));
      result={access_token:'fixture-only',refresh_token:'fixture-refresh',expires_in:3600,scope:BASE_SCOPES.join(' ')};
    }else{
      assert.equal(u.pathname,'/youtube/v3/channels');pages++;const offset=u.searchParams.has('pageToken')?10:0;
      result={items:Array.from({length:offset?8:10},(_,i)=>({id:'UC'+String(i+offset).padStart(22,'0'),snippet:{title:'测试频道 '+(i+offset)},contentDetails:{relatedPlaylists:{uploads:'fixture-list'}}})),...(offset?{}:{nextPageToken:'next-channels'})};
    }
    return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});
  };
  try{const connected=await finish(env,OWNER,'oauth-owner',query);assert.equal(connected.length,18);assert.equal(pages,2);await assert.rejects(()=>finish(env,OWNER,'oauth-owner',query));}finally{globalThis.fetch=original;}
});

test('catalog pagination, thumbnails and analytics survive duplicate work and persist usable data',async()=>{
  const cid='UC'+String(0).padStart(22,'0'),first='test0000000';
  const env:any={DB:db,FILES:bucket,SYNC_QUEUE:{send:async()=>{}},...bindings};let playlistPages=0,apiReports=0;const original=globalThis.fetch;
  globalThis.fetch=async(input:any)=>{
    const u=new URL(String(input));let response:any;
    if(u.hostname==='i.ytimg.com')return new Response(new Uint8Array([255,216,255,217]),{headers:{'Content-Type':'image/jpeg'}});
    if(u.pathname.endsWith('/playlistItems')){playlistPages++;const offset=u.searchParams.has('pageToken')?50:0;response={items:Array.from({length:offset?2:50},(_,i)=>({contentDetails:{videoId:'test'+String(i+offset).padStart(7,'0')}})),...(offset?{}:{nextPageToken:'next-videos'})};}
    else if(u.pathname.endsWith('/videos'))response={items:u.searchParams.get('id')!.split(',').map((id,i)=>({id,snippet:{channelId:cid,title:'合成测试 '+id,publishedAt:'2026-09-01T00:00:00Z',thumbnails:{high:{url:'https://i.ytimg.com/vi/'+id+'/hqdefault.jpg'}}},contentDetails:{duration:'PT42M'},statistics:{viewCount:String(10000-i)}}))};
    else if(u.hostname==='youtubeanalytics.googleapis.com'){apiReports++;response={columnHeaders:[{name:'elapsedVideoTimeRatio'},{name:'audienceWatchRatio'},{name:'relativeRetentionPerformance'}],rows:[[.01,1.1,.7],[.5,.5,.6],[1,.3,.5]]};}
    else throw new Error('Unexpected mock request '+u.hostname+u.pathname);
    return new Response(JSON.stringify(response),{headers:{'Content-Type':'application/json'}});
  };
  const deliver=async(id:string)=>consume(env,{messages:[{body:{id},ack:()=>{},retry:()=>assert.fail('fixture work should complete')}] } as any);
  const drain=async(task:string)=>{for(let round=0;round<40;round++){const rows=await db.prepare("SELECT id FROM ff_work WHERE task_id=? AND status IN ('pending','queued')").bind(task).all();if(!rows.results.length)return;for(const row of rows.results)await deliver(row.id);}assert.fail('work did not drain');};
  try{
    const catalog=await startTask(env,cid,'catalog',OWNER,null,null);await drain(catalog);assert.equal(playlistPages,2);
    const count=await db.prepare("SELECT count(*) n FROM ff_videos WHERE channel_id=? AND thumbnail_status='saved' AND duration=2520").bind(cid).first();assert.equal(count.n,52);
    const work=await db.prepare("SELECT id FROM ff_work WHERE task_id=? AND kind='catalog' LIMIT 1").bind(catalog).first();await deliver(work.id);assert.equal(playlistPages,2);
    const listing=await data('/api/videos?channel='+cid+'&page=2');assert.equal(listing.total,52);assert.equal(listing.items.length,24);
    const search=await data('/api/videos?channel='+cid+'&q=test0000051');assert.equal(search.items.length,1);
    const task=await startTask(env,cid,'reports',OWNER,'2026-09-01','2026-09-26',{reports:['retention'],video_ids:[first]});await drain(task);assert.equal(apiReports,1);
    const detail=await data(`/api/videos/${cid}/${first}?start=2026-09-01&end=2026-09-26`);assert.ok(Math.abs(detail.reports[0].data.dataset.points[0].retention_pct-110)<1e-9);
    assert.equal((await db.prepare('SELECT status FROM ff_tasks WHERE id=?').bind(task).first()).status,'success');
    const raw=await data('/api/reports/'+detail.reports[0].id+'/raw');assert.ok(raw.query.filters.includes(first));
    const invalid=await request(`/api/channels/${cid}/tasks`,{kind:'reports',reports:['toString'],start:'2026-09-01',end:'2026-09-26'});assert.equal(invalid.status,403);
  }finally{globalThis.fetch=original;}
});
