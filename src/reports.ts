import Papa from 'papaparse';
import {AppError,Row,Person,isAdmin} from './types';
export const REPORTS:Record<string,{name:string,metrics:string,dimension?:string,filters?:string,money?:boolean}>= {
  summary:{name:'观看与互动汇总',metrics:'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained,subscribersLost'},
  daily:{name:'每日观看趋势',dimension:'day',metrics:'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage'},
  retention:{name:'全部观众留存',dimension:'elapsedVideoTimeRatio',metrics:'audienceWatchRatio,relativeRetentionPerformance'},
  retention_detail:{name:'片段观看活动',dimension:'elapsedVideoTimeRatio',metrics:'startedWatching,stoppedWatching,totalSegmentImpressions'},
  retention_subscribed:{name:'订阅者留存',dimension:'elapsedVideoTimeRatio',metrics:'audienceWatchRatio',filters:'subscribedStatus==SUBSCRIBED'},
  retention_unsubscribed:{name:'非订阅者留存',dimension:'elapsedVideoTimeRatio',metrics:'audienceWatchRatio',filters:'subscribedStatus==UNSUBSCRIBED'},
  retention_organic:{name:'自然流量留存',dimension:'elapsedVideoTimeRatio',metrics:'audienceWatchRatio',filters:'audienceType==ORGANIC'},
  traffic:{name:'流量来源',dimension:'insightTrafficSourceType',metrics:'views,estimatedMinutesWatched'},
  countries:{name:'观众地区',dimension:'country',metrics:'views,estimatedMinutesWatched'},
  devices:{name:'观看设备',dimension:'deviceType',metrics:'views,estimatedMinutesWatched'},
  subscribers:{name:'订阅状态',dimension:'subscribedStatus',metrics:'views,estimatedMinutesWatched'},
  demographics:{name:'年龄与性别',dimension:'ageGroup,gender',metrics:'viewerPercentage'},
  os:{name:'操作系统',dimension:'operatingSystem',metrics:'views,estimatedMinutesWatched'},
  playback:{name:'播放位置',dimension:'insightPlaybackLocationType',metrics:'views,estimatedMinutesWatched'},
  sharing:{name:'分享平台',dimension:'sharingService',metrics:'shares'},
  engagement:{name:'互动补充',metrics:'likes,dislikes,comments,shares,videosAddedToPlaylists,videosRemovedFromPlaylists'},
  cards:{name:'信息卡',metrics:'cardImpressions,cardClicks,cardClickRate,cardTeaserImpressions,cardTeaserClicks,cardTeaserClickRate'},
  premium:{name:'Premium 观看',metrics:'redViews,estimatedRedMinutesWatched'},
  revenue:{name:'收入与广告汇总（USD）',metrics:'estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue,monetizedPlaybacks,playbackBasedCpm,adImpressions,cpm',money:true},
  revenue_daily:{name:'每日估算收入（USD）',dimension:'day',metrics:'estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue',money:true}
};
export function canReport(p:Person,kind:string){return isAdmin(p)||(Object.hasOwn(REPORTS,kind)&&(!REPORTS[kind].money||p.permissions.revenue===true));}
export function normalize(raw:any,kind:string){
  const columns=(raw.columnHeaders||[]).map((c:any)=>c.name);const rows=(raw.rows||[]).map((values:any[])=>Object.fromEntries(columns.map((k:string,i:number)=>[k,values[i]])));
  const value:Row={columns,rows,last_returned_day:columns.includes('day')?rows.map((r:Row)=>r.day).sort().at(-1)||null:null};
  if(kind.startsWith('retention'))value.dataset={name:REPORTS[kind]?.name||'导入留存',source:'analytics_api',position_basis:'exclusive_interval_end',status:rows.length?'success':'no_data',points:rows.map((r:Row)=>({position_pct:Number(r.elapsedVideoTimeRatio)*100,group:REPORTS[kind]?.name||'全部',retention_pct:r.audienceWatchRatio==null?null:Number(r.audienceWatchRatio)*100,relative_retention_score:r.relativeRetentionPerformance??null,started_watching:r.startedWatching??null,stopped_watching:r.stoppedWatching??null,segment_views:r.totalSegmentImpressions??null}))};
  return value;
}
function number(value:any){if(value==null||['','-','—','N/A'].includes(String(value).trim()))return null;const n=Number(String(value).replace(/,/g,'').replace(/%$/,''));if(!Number.isFinite(n))throw new AppError(400,'CSV 中有无效数值。');return n;}
export function csv(raw:string){
  const parsed=Papa.parse<string[]>(raw.replace(/^\uFEFF/,''),{skipEmptyLines:'greedy'});
  if(parsed.errors.length)throw new AppError(400,'CSV 格式错误：'+parsed.errors[0].message);
  const [columns,...values]=parsed.data;
  if(!columns?.length||columns.length>200||new Set(columns).size!==columns.length||columns.some(c=>!c.trim()))throw new AppError(400,'CSV 表头为空、重复或列数过多。');
  if(values.length>10000||values.some(v=>v.length!==columns.length))throw new AppError(400,'单文件最多 10000 行，且每行必须与表头列数一致。');
  return {columns,rows:values.map(v=>Object.fromEntries(columns.map((c,i)=>[c,v[i]])))};
}
export function studio(raw:string,name:string){
  const table=csv(raw);const position='在视频中的位置 (%)';
  if(!table.columns.includes(position))return {kind:'studio_table',data:table};
  const rate=table.columns.includes('绝对观众黏度 (%)')?'绝对观众黏度 (%)':'绝对观众粘度 (%)';
  const counts:Record<string,string>={'开始观看的观看者':'started_watching','停止观看的观看者':'stopped_watching','各片段的观看次数':'segment_views'};
  if(!table.columns.includes(rate)&&!Object.keys(counts).some(c=>table.columns.includes(c)))throw new AppError(400,'留存 CSV 缺少观众黏度或片段活动列。');
  // Unknown columns may contain sensitive data. Only known audience segment labels become chart groups.
  const groupColumns=table.columns.filter(c=>/^(订阅状态|观众类型|流量类型|细分|观众|类型)$/.test(c));const seen=new Set<string>();
  const points=table.rows.map((r,i)=>{
    const pct=number(r[position]);if(pct===null||pct<0||pct>100)throw new AppError(400,`第 ${i+2} 行视频位置无效。`);
    const group=groupColumns.map(c=>r[c]).join(' / ')||name.replace(/\.csv$/i,'');const id=group+':'+pct;
    if(seen.has(id))throw new AppError(400,'存在重复曲线位置，请分别导入各观众细分的 CSV。');seen.add(id);
    const p:Row={position_pct:pct,group,retention_pct:number(r[rate])};for(const [a,b] of Object.entries(counts))p[b]=number(r[a]);
    if(Object.entries(p).some(([k,v])=>k!=='group'&&v!==null&&Number(v)<0))throw new AppError(400,'留存与次数不得为负数。');return p;
  });
  return {kind:'studio_retention',data:{dataset:{name,source:'studio_csv',position_basis:'studio_export_label',status:points.length?'success':'no_data',points},columns:table.columns,rows:table.rows}};
}
export function csvExport(rows:Row[],columns:string[]){
  const protect=(v:any)=>typeof v==='string'&&/^[\s]*[=+\-@\t\r]/.test(v)?"'"+v:v;
  return '\uFEFF'+Papa.unparse({fields:columns,data:rows.map(r=>columns.map(c=>protect(r[c]??'')))});
}
export function duration(iso:string){const m=/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso||'');return m?m.slice(1).reduce((n,s,i)=>n+Number(s||0)*[86400,3600,60,1][i],0):null;}
export function reachCsv(raw:string,cid:string,day:string){
  const table=csv(raw);const required=['date','channel_id','video_id','video_thumbnail_impressions','video_thumbnail_impressions_ctr'];if(!required.every(k=>table.columns.includes(k)))throw new AppError(400,'覆盖面报表缺少必要列。');
  const seen=new Set();return table.rows.map(r=>{
    const d=r.date.includes('-')?r.date:`${r.date.slice(0,4)}-${r.date.slice(4,6)}-${r.date.slice(6,8)}`;
    if(d!==day||(r.channel_id&&r.channel_id!==cid)||seen.has(r.video_id))throw new AppError(400,'覆盖面报表日期、频道或视频行不匹配。');seen.add(r.video_id);
    const impressions=number(r.video_thumbnail_impressions),ctr=number(r.video_thumbnail_impressions_ctr);
    if(impressions===null||impressions<0||!Number.isInteger(impressions)||(ctr!==null&&(ctr<0||ctr>100)))throw new AppError(400,'覆盖面报表存在无效数值。');
    return {video_id:r.video_id,impressions,ctr_raw:ctr};
  });
}
export function verifiedRatio(rows:Row[]){const good=rows.filter(r=>r.impressions&&r.ctr_raw);const whole=(x:number)=>Math.abs(x-Math.round(x))<=1e-5;return good.length>=10&&good.every(r=>r.ctr_raw>0&&r.ctr_raw<=1&&whole(r.impressions*r.ctr_raw))&&good.filter(r=>!whole(r.impressions*r.ctr_raw/100)).length>=10;}
