import {AppError,Env,one} from './types';
import {ensureLibrary} from './library';

function detail(error:unknown){
  const messages:string[]=[];let current:any=error;
  for(let i=0;i<4&&current;i++,current=current.cause)messages.push(String(current.message||current));
  return messages.join(' ');
}
export function missingTable(error:unknown,table:string){return detail(error).includes(`no such table: ${table}`);}
export function databaseFailure(error:unknown){
  if(error instanceof AppError)return error;
  const message=detail(error);
  if(/D1/i.test(message)&&/exceeded|limit|quota/i.test(message)&&/daily|free tier|rows? read|rows? writ/i.test(message))return new AppError(503,'Cloudflare D1 今日免费读写额度已用完。每日北京时间 08:00 重置；也可由账户管理员评估升级 Workers 方案。无需重新初始化数据库或重新授权频道。','database_quota');
  return new AppError(503,'暂时无法读取云端数据库。请稍后重试，或由管理员检查 Cloudflare D1 状态。不要重新初始化或清空数据。','database_unavailable');
}
export async function initialized(env:Env){
  let version;
  try{version=await one(env.DB,"SELECT value FROM ff_meta WHERE key='schema_version'");}
  catch(error){if(missingTable(error,'ff_meta'))return false;throw databaseFailure(error);}
  if(!version)return false;
  if(version.value!=='1')throw new AppError(503,'数据库版本与程序不一致，请联系管理员检查部署。不要重新初始化。','database_version');
  try{await ensureLibrary(env);}catch(error){throw databaseFailure(error);}
  return true;
}
