import {readFile, writeFile} from 'node:fs/promises';
const config = JSON.parse(await readFile(new URL('../cloudflare.config.json', import.meta.url), 'utf8'));
const production = process.argv.includes('--production');
const local = process.argv.includes('--local');
if(production && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(config.database_id)) {
  throw new Error('请先在 cloudflare.config.json 中填写 D1 的完整 database_id。截图中截断的 UUID 不能使用。');
}
for (const name of ['worker_name','database_name','bucket_name','queue_name']) {
  if(!/^[a-z][a-z0-9-]{2,62}$/.test(config[name])) throw new Error(`${name} 只能使用小写字母、数字、短横线，长度 3—63。`);
}
const id = /^[a-f0-9-]{36}$/i.test(config.database_id) ? config.database_id : '00000000-0000-4000-8000-000000000000';
const result = {
  name:config.worker_name, main:'src/index.ts', compatibility_date:'2026-09-28',
  compatibility_flags:['nodejs_compat'], workers_dev:true, preview_urls:false, keep_vars:true,
  assets:{directory:'./public',binding:'ASSETS',not_found_handling:'single-page-application',run_worker_first:true},
  d1_databases:[{binding:'DB',database_name:config.database_name,database_id:id}],
  r2_buckets:[{binding:'FILES',bucket_name:config.bucket_name}],
  queues:{producers:[{binding:'SYNC_QUEUE',queue:config.queue_name}],consumers:[{queue:config.queue_name,max_batch_size:1,max_batch_timeout:1,max_retries:3,max_concurrency:1,retry_delay:60}]},
  rules:[{type:'Text',globs:['**/*.sql'],fallthrough:true}],
  observability:{enabled:true,head_sampling_rate:1,logs:{enabled:true,invocation_logs:false}},
  ...(local?{vars:{LOCAL_DEV:'true',OWNER_EMAIL:'owner@example.test',ACCESS_TEAM_DOMAIN:'',ACCESS_AUD:''}}:{})
};
await writeFile(new URL('../wrangler.generated.jsonc', import.meta.url), JSON.stringify(result,null,2)+'\n');
console.log(production?'Cloudflare 配置检查通过。':'Cloudflare 配置已生成；尚未修改云端资源。');
