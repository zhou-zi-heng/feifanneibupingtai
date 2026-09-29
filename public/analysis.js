/* Pure helpers shared by the interactive charts and Node regression tests. */
(function(root){
  'use strict';
  function clock(seconds, decimals=false){
    if(seconds==null || !Number.isFinite(Number(seconds)))return '—';
    const value=Math.max(0,Number(seconds)), total=decimals?Math.round(value*10)/10:Math.floor(value);
    const h=Math.floor(total/3600), m=Math.floor(total%3600/60), s=total%60;
    const tail=decimals?s.toFixed(1).padStart(4,'0'):String(Math.floor(s)).padStart(2,'0');
    return h?`${h}:${String(m).padStart(2,'0')}:${tail}`:`${m}:${tail}`;
  }
  function interval(point,basis,duration){
    if(!duration)return {start:null,end:null,label:`${point.position_pct}% · 时长未知`,exact:false};
    const end=Number((point.position_pct/100*duration).toFixed(6));
    if(basis==='exclusive_interval_end'){
      const start=Number((Math.max(0,point.position_pct-1)/100*duration).toFixed(6));
      return {start,end,label:`${clock(start,true)} – ${clock(end,true)}`,exact:true};
    }
    return {start:end,end,label:`约 ${clock(end,true)} · CSV 位置标签`,exact:false};
  }
  function peaks(points,threshold=2){
    const results=[];
    for(const group of new Set(points.map(p=>p.group))){
      const ps=points.filter(p=>p.group===group&&Number.isFinite(p.retention_pct)).sort((a,b)=>a.position_pct-b.position_pct);
      for(let i=1;i<ps.length-1;i++){
        let end=i;
        while(end+1<ps.length&&ps[end+1].retention_pct===ps[i].retention_pct&&ps[end+1].position_pct-ps[end].position_pct<=1.01)end++;
        if(end===ps.length-1){i=end;continue;}
        const contiguous=ps[i].position_pct-ps[i-1].position_pct<=1.01&&ps[end+1].position_pct-ps[end].position_pct<=1.01;
        if(contiguous&&ps[i].retention_pct>ps[i-1].retention_pct&&ps[end].retention_pct>ps[end+1].retention_pct){
          const left=[],right=[];
          for(let j=i-1;j>=Math.max(0,i-5)&&ps[j+1].position_pct-ps[j].position_pct<=1.01;j--)left.push(ps[j].retention_pct);
          for(let j=end+1;j<=Math.min(ps.length-1,end+5)&&ps[j].position_pct-ps[j-1].position_pct<=1.01;j++)right.push(ps[j].retention_pct);
          const prominence=Number((ps[i].retention_pct-Math.max(Math.min(...left),Math.min(...right))).toFixed(6));
          if(prominence>=threshold)results.push({...ps[Math.floor((i+end)/2)],prominence,start_pct:ps[i].position_pct,end_pct:ps[end].position_pct});
        }
        i=end;
      }
    }
    return results.sort((a,b)=>b.prominence-a.prominence||a.position_pct-b.position_pct);
  }
  function lines(points,metric){
    const chunks=[];let chunk=[];
    for(const p of [...points].sort((a,b)=>a.position_pct-b.position_pct)){
      if(p[metric]==null){if(chunk.length)chunks.push(chunk);chunk=[];continue;}
      if(chunk.length&&p.position_pct-chunk[chunk.length-1].position_pct>1.05){chunks.push(chunk);chunk=[];}
      chunk.push(p);
    }
    if(chunk.length)chunks.push(chunk);
    return chunks;
  }
  function sortVideos(items,key,ascending=false){
    const value=v=>key==='views'?v.lifetime_views:key==='period_views'?v.summary?.views:key==='retention'?v.summary?.averageViewPercentage:v.published_at;
    return [...items].sort((a,b)=>{
      const x=value(a),y=value(b);if(x==null&&y==null)return String(a.video_id).localeCompare(b.video_id);if(x==null)return 1;if(y==null)return -1;
      return (typeof x==='string'?x.localeCompare(y):x-y)*(ascending?1:-1)||String(a.video_id).localeCompare(b.video_id);
    });
  }
  const api={clock,interval,peaks,lines,sortVideos};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RetentionMath=api;
})(typeof window!=='undefined'?window:this);
