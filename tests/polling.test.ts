import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function page(reply:(path:string)=>any){
  const app={innerHTML:''};const calls:string[]=[];
  const context=vm.createContext({console,URLSearchParams,AbortSignal,Date,
    window:{RetentionMath:{clock:()=>''},addEventListener(){}},location:{hash:''},
    document:{hidden:false,querySelector:(s:string)=>s==='#app'?app:null,querySelectorAll:()=>[],addEventListener(){},createElement:()=>({remove(){}})},
    setInterval(){},setTimeout(){},fetch:async(path:string)=>{calls.push(path);const value=reply(path);return {ok:!value.error,status:value.error?503:200,headers:{get:()=> 'application/json'},json:async()=>value};}
  });
  vm.runInContext(await readFile('public/app.js','utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  return {context,app,calls};
}
test('quota on startup shows a recoverable service error without an initialize action',async()=>{
  const p=await page(()=>({error:'Cloudflare D1 今日额度已用完',code:'database_quota'}));
  assert.match(p.app.innerHTML,/数据服务暂时不可用/);
  assert.doesNotMatch(p.app.innerHTML,/data-act="initialize"/);
  await vm.runInContext('poll(false)',p.context);
  assert.deepEqual(p.calls,['/api/me']);
});
test('unchanged idle pages use lightweight polling at most once per two minutes',async()=>{
  const p=await page(path=>path==='/api/me'?{initialized:false}:{items:[]});
  vm.runInContext("S.me={initialized:true};S.taskRevision='[]';S.tasks=[];S.lastPoll=0;",p.context);
  await vm.runInContext('poll(false)',p.context);
  await vm.runInContext('poll(false)',p.context);
  assert.deepEqual(p.calls,['/api/me','/api/tasks?summary=1']);
  vm.runInContext('S.lastPoll=Date.now()-121000',p.context);
  await vm.runInContext('poll(false)',p.context);
  assert.equal(p.calls.filter(x=>x==='/api/tasks?summary=1').length,2);
  assert.equal(p.calls.includes('/api/tasks'),false);
});
