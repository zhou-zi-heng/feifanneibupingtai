import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('Google requests run in Workers and do not follow redirects with credentials',async()=>{
  const output=await build({stdin:{contents:`import {http} from './src/google'; export default {async fetch(){try {const response=await http('https://oauth2.googleapis.com/token',{method:'POST',body:'test-only',headers:{Authorization:'Bearer synthetic'}});return new Response(await response.text());}catch(e){return Response.json({message:e.message,retryable:e.retryable},{status:e.status||500});}}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});
  let redirect=false;const requests:string[]=[];
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:output.outputFiles[0].text,compatibilityDate:'2026-09-28',outboundService:async(req:any)=>{requests.push(req.url);return redirect?new Response(null,{status:302,headers:{Location:'https://unexpected.example/token'}}):new Response('ok');}}));
  try {
    let response=await mf.dispatchFetch('http://localhost/');assert.equal(response.status,200);assert.equal(await response.text(),'ok');assert.equal(requests.length,1);
    redirect=true;response=await mf.dispatchFetch('http://localhost/');assert.equal(response.status,502);const error:any=await response.json();assert.match(error.message,/意外重定向/);assert.equal(error.retryable,false);assert.equal(requests.length,2);assert.ok(requests.every(url=>url==='https://oauth2.googleapis.com/token'));
  } finally {await mf.dispose();}
});
