'use strict';
window.RetentionChart=function(host,{dataset,duration,metric='retention_pct',threshold=2,videoId='',onFocus=()=>{}}){
  const M=window.RetentionMath, colors=['#087f8c','#ce8433','#7270c9','#b75278'];
  const labels={retention_pct:'观众留存',started_watching:'开始观看',stopped_watching:'停止观看',segment_views:'片段观看次数',relative_retention_score:'相对留存分数'};
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const points=dataset?.points||[], groups=[...new Set(points.map(p=>p.group))], marked=M.peaks(points,threshold);
  let lo=0,hi=100,selection=null,observer=null,active=true;
  if(!points.some(p=>p[metric]!=null)){
    host.innerHTML=`<div class="chart-empty"><span>◌</span><h3>${dataset?.status==='error'?'这项报表采集失败':'这项报表没有可用曲线'}</h3><p>${escape(dataset?.error||'API 未返回此指标的数据。无数据不等于数值为零；可以重新采集，或导入 Studio 的 CSV。')}</p></div>`;
    return {destroy(){},focus(){}};
  }
  function render(){
    if(!active)return;
    const width=Math.max(280,host.clientWidth),height=340,left=52,right=22,top=28,bottom=45,cw=width-left-right,ch=height-top-bottom;
    const visible=points.filter(p=>p.position_pct>=lo&&p.position_pct<=hi&&p[metric]!=null);
    const peak=Math.max(1,...visible.map(p=>p[metric]));
    const ymax=metric==='retention_pct'?Math.max(100,Math.ceil(peak/20)*20):metric==='relative_retention_score'?1:Math.max(1,Math.ceil(peak/10)*10);
    const x=p=>left+(p-lo)/(hi-lo)*cw, y=v=>top+ch*(1-v/ymax);
    let svg=`<svg viewBox="0 0 ${width} ${height}" class="retention-svg" role="img" tabindex="0" aria-label="${labels[metric]}时间曲线"><defs><clipPath id="plotClip"><rect x="${left}" y="${top}" width="${cw}" height="${ch}"/></clipPath><linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#087f8c" stop-opacity=".13"/><stop offset="100%" stop-color="#087f8c" stop-opacity="0"/></linearGradient></defs>`;
    for(let i=0;i<=4;i++){const yy=top+ch*i/4;svg+=`<line x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}" class="grid-line"/><text x="${left-10}" y="${yy+4}" text-anchor="end" class="axis-label">${Number((ymax*(1-i/4)).toFixed(2))}${metric==='retention_pct'?'%':''}</text>`;}
    const ticks=width<480?3:5;
    for(let i=0;i<=ticks;i++){const pct=lo+(hi-lo)*i/ticks;svg+=`<text x="${x(pct)}" y="${height-18}" text-anchor="middle" class="axis-label">${duration?M.clock(pct/100*duration):pct.toFixed(0)+'%'}</text>`;}
    svg+='<g clip-path="url(#plotClip)">';
    groups.forEach((g,i)=>{
      for(const line of M.lines(points.filter(p=>p.group===g),metric)){
        const path=line.map((p,j)=>`${j?'L':'M'}${x(p.position_pct)} ${y(p[metric])}`).join(' ');
        if(groups.length===1)svg+=`<path d="${path} L${x(line.at(-1).position_pct)} ${top+ch} L${x(line[0].position_pct)} ${top+ch} Z" fill="url(#curveFill)"/>`;
        svg+=`<path d="${path}" stroke="${colors[i%colors.length]}" class="data-line"/>`;
        if(line.length===1)svg+=`<circle cx="${x(line[0].position_pct)}" cy="${y(line[0][metric])}" r="2.5" fill="${colors[i%colors.length]}"/>`;
      }
    });
    if(metric==='retention_pct')marked.forEach(p=>{svg+=`<circle cx="${x(p.position_pct)}" cy="${y(p.retention_pct)}" r="4" fill="#e09b45" stroke="white" stroke-width="2"/>`;});
    svg+='</g><line id="crosshair" class="crosshair" visibility="hidden"/><g id="hoverDots"></g></svg>';
    host.innerHTML=`<div class="chart-toolbar"><span>${escape(labels[metric])}${metric==='retention_pct'?' · %':''}</span><button class="text-button" data-reset>重置缩放</button></div><div class="plot">${svg}<div class="chart-tooltip" role="status" hidden></div></div><div class="chart-legend">${groups.map((g,i)=>`<span><i style="background:${colors[i%colors.length]}"></i>${escape(g)}</span>`).join('')}</div><div class="chart-range"><label>起点<input type="range" min="0" max="99" step="1" value="${lo}" aria-label="图表起点"></label><label>终点<input type="range" min="1" max="100" step="1" value="${hi}" aria-label="图表终点"></label></div><div class="chart-hint">${duration?'横轴为视频时间':'缺少时长，暂用百分比轴'} · 拖动滑块放大 · 悬停查看区间 · 点击固定位置</div>`;
    const element=host.querySelector('svg'),tooltip=host.querySelector('.chart-tooltip'),cross=host.querySelector('#crosshair');
    function show(pct,pin=false){
      const selected=groups.map(g=>{
        const ps=points.filter(p=>p.group===g&&p[metric]!=null);
        if(dataset.position_basis==='exclusive_interval_end')return ps.find(p=>pct>=p.position_pct-1-1e-6&&pct<p.position_pct)||(pct>=100?ps.find(p=>p.position_pct===100):null);
        return ps.reduce((best,p)=>!best||Math.abs(p.position_pct-pct)<Math.abs(best.position_pct-pct)?p:best,null);
      });
      const point=selected.find(Boolean);
      const xx=x(Math.min(hi,Math.max(lo,pct)));
      cross.setAttribute('x1',xx);cross.setAttribute('x2',xx);cross.setAttribute('y1',top);cross.setAttribute('y2',top+ch);cross.setAttribute('visibility','visible');
      tooltip.hidden=false;
      tooltip.style.left=Math.min(width-235,Math.max(0,xx+12))+'px';tooltip.style.top='12px';
      const range=point?M.interval(point,dataset.position_basis,duration):null;
      tooltip.innerHTML=`<b>${range?escape(range.label):'此时间段缺少数据'}</b>${selected.map((p,i)=>`<div><span>${escape(groups[i])}</span><strong>${p?Number(p[metric].toFixed(2))+(metric==='retention_pct'?'%':''):'—'}</strong></div>`).join('')}<small>${pin?'已固定 · 移出后保留':'点击固定此位置'}${range?.exact?' · 区间末端不包含在内':''}</small>`;
      host.querySelector('#hoverDots').innerHTML=selected.map((p,i)=>p?`<circle cx="${x(p.position_pct)}" cy="${y(p[metric])}" r="4" fill="${colors[i%colors.length]}" stroke="white" stroke-width="2"/>`:'').join('');
      if(pin){selection=pct;onFocus(point,range);}
    }
    element.addEventListener('pointermove',event=>{const rect=element.getBoundingClientRect();show(lo+((event.clientX-rect.left)*width/rect.width-left)/cw*(hi-lo));});
    element.addEventListener('click',event=>{const rect=element.getBoundingClientRect();show(Math.max(lo,Math.min(hi,lo+((event.clientX-rect.left)*width/rect.width-left)/cw*(hi-lo))),true);});
    element.addEventListener('pointerleave',()=>{if(selection!==null)show(selection,true);else{tooltip.hidden=true;cross.setAttribute('visibility','hidden');host.querySelector('#hoverDots').innerHTML='';}});
    element.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();show(Math.min(hi-.001,Math.max(lo,(selection??lo)+(event.key==='ArrowRight'?1:-1))),true);}});
    const ranges=host.querySelectorAll('input[type=range]');
    ranges[0].onchange=e=>{lo=Math.max(0,Math.min(Number(e.target.value),hi-2));render();host.querySelectorAll('input[type=range]')[0].focus();};
    ranges[1].onchange=e=>{hi=Math.min(100,Math.max(Number(e.target.value),lo+2));render();host.querySelectorAll('input[type=range]')[1].focus();};
    host.querySelector('[data-reset]').onclick=()=>{lo=0;hi=100;selection=null;render();};
    if(selection!==null)show(selection,true);
  }
  render();let previousWidth=host.clientWidth;
  observer=new ResizeObserver(()=>{if(Math.abs(host.clientWidth-previousWidth)>2){previousWidth=host.clientWidth;render();}});observer.observe(host);
  return {destroy(){active=false;observer?.disconnect();},focus(pct){selection=Math.max(0,pct-.001);if(pct<lo||pct>hi){lo=Math.max(0,pct-8);hi=Math.min(100,pct+8);}render();}};
};
