'use strict';
document.getElementById('download-config').addEventListener('click',()=>{
  const worker=document.getElementById('worker-name').value.trim();
  const id=document.getElementById('database-id').value.trim();
  const status=document.getElementById('config-status');
  if(!/^[a-z][a-z0-9-]{2,62}$/.test(worker)){status.textContent='请填写 Cloudflare 中的 Worker 名称，只使用小写字母、数字、短横线，长度 3—63。';status.className='error';return;}
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)){status.textContent='请粘贴完整 UUID，不能包含省略号、空格或中文。';status.className='error';return;}
  const data={worker_name:worker,database_name:'feifan-web-db',database_id:id,bucket_name:'feifan-web-files',queue_name:'feifan-web-sync'};
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='cloudflare.config.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  status.textContent='已生成下载。请将文件放回“飞凡内部数据平台网页版”目录，替换同名文件。';status.className='success';
});
document.getElementById('generate-key').addEventListener('click',()=>{
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  document.getElementById('new-key').value=btoa(String.fromCharCode(...bytes));
  document.getElementById('key-output').hidden=false;
  document.getElementById('generate-key').textContent='密钥已生成（请妥善保存）';
  document.getElementById('generate-key').disabled=true;
});
