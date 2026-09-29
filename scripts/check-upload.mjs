import {readdir,readFile} from 'node:fs/promises';
const ignored=new Set(['node_modules','.git','.wrangler','.bundle','verification']);
let count=0;
async function walk(path='.'){
  for(const item of await readdir(path,{withFileTypes:true})){
    if(ignored.has(item.name))continue;
    const next=`${path}/${item.name}`;
    if(item.isDirectory()){await walk(next);continue;}
    if(/^\.dev\.vars|^\.env|credentials|client_secret.*\.json|\.dpapi$/.test(item.name))throw new Error(`不可上传的本地凭据文件：${next}`);
    if(item.name==='wrangler.generated.jsonc')continue;
    const value=await readFile(next,'utf8');
    if(/"refresh_token"\s*:\s*"1\/|GOCSPX-[A-Za-z0-9_-]{20}/.test(value))throw new Error(`疑似真实 Google 密钥：${next}`);
    count++;
  }
}
await walk(); console.log(`检查 ${count} 个发布文件，未发现已知本地凭据格式。请勿上传 node_modules、.dev.vars 或本地数据目录。`);
