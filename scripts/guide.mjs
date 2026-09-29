import {readFile,writeFile} from 'node:fs/promises';
const content=await readFile(new URL('../部署教程.md',import.meta.url),'utf8');
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const inline=s=>esc(s).replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1 ↗</a>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
let body='',section=0,list='',table=false,code=false;const nav=[];
function close(){if(list){body+='</'+list+'>';list='';}if(table){body+='</tbody></table></div>';table=false;}}
for(const line of content.split(/\r?\n/)){
  if(line.startsWith('~~~')){close();if(code)body+='</code></pre>';else body+='<pre><code>';code=!code;continue;}
  if(code){body+=esc(line)+'\n';continue;}
  if(!line.trim()){close();continue;}
  if(line.startsWith('# '))continue;
  if(line.startsWith('## ')){close();const title=line.slice(3),id='step-'+section++;nav.push({title,id});body+='<h2 id="'+id+'">'+inline(title)+'</h2>';continue;}
  if(line.startsWith('|')){if(/^\|\s*---/.test(line))continue;const cells=line.slice(1,-1).split('|');if(!table){close();body+='<div class="table-wrap"><table><tbody>';table=true;}body+='<tr>'+cells.map(c=>'<td>'+inline(c.trim())+'</td>').join('')+'</tr>';continue;}
  const numbered=/^\d+\.\s+(.+)/.exec(line),bullet=/^\s*-\s+(.+)/.exec(line);
  if(numbered||bullet){const kind=numbered?'ol':'ul';if(list!==kind){close();body+='<'+kind+'>';list=kind;}body+='<li>'+inline((numbered||bullet)[1])+'</li>';continue;}
  close();body+='<p>'+inline(line)+'</p>';
}
close();
const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>一步一步部署 · 飞凡内部数据平台</title><link rel="stylesheet" href="guide.css"><script src="guide.js" defer></script></head><body><aside><div class="brand">凡 <span>飞凡内部数据平台<small>部署与使用指南</small></span></div><nav>'+nav.map(n=>'<a href="#'+n.id+'">'+esc(n.title)+'</a>').join('')+'</nav><p>2026-09-29 · WEB 0.1<br>可离线查看，配置在本机生成。</p></aside><main><header><span class="eyebrow">FEIFAN / GET STARTED</span><h1>把工作室的数据，<br>放到自己的云端。</h1><p>从一个频道开始验证。跟着以下步骤完成部署，再邀请同事登录。</p><div class="tags"><span>无需自购服务器</span><span>暂不需要域名</span><span>新建独立数据库</span></div></header><section class="tools"><h2>部署时用到的两个小工具</h2><div class="helper"><h3>生成数据库配置</h3><p>第 3 步使用。只粘贴新建的 feifan-web-db 的完整 UUID。</p><label for="database-id">新数据库 ID</label><input id="database-id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" spellcheck="false"><button id="download-config">下载 cloudflare.config.json</button><p id="config-status" role="status">下载后放回代码文件夹，替换同名文件。</p></div><div class="helper"><h3>生成初次部署密钥</h3><p>第 7 步使用。只在第一次配置 TOKEN_KEY 时生成，之后保存在密码管理器中。此工具不会发送或保存你生成的密钥。</p><button id="generate-key">生成 32 字节密钥</button><div id="key-output" hidden><label for="new-key">复制到 Cloudflare 的 TOKEN_KEY（Secret）</label><textarea id="new-key" rows="2" readonly spellcheck="false"></textarea><p>不要上传 GitHub，不要把这个值填进数据库 ID，也不要覆盖正在使用的密钥。</p></div></div></section><article>'+body+'</article><footer>本教程和配置工具不会替你创建云资源、购买服务或连接账号。操作在你的 Cloudflare 与 Google 控制台完成。</footer></main></body></html>';
await writeFile(new URL('../public/guide.html',import.meta.url),html);
console.log('部署向导已生成。');

