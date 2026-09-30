import {Env,AppError,one,run,dates} from './types';

// Additive migration: existing archives and authorization remain intact.
export async function ensureLibrary(env:Env){
  await run(env.DB,`CREATE TABLE IF NOT EXISTS ff_video_trash(channel_id TEXT NOT NULL,video_id TEXT NOT NULL,deleted_at TEXT NOT NULL,deleted_by TEXT NOT NULL,PRIMARY KEY(channel_id,video_id))`);
  await run(env.DB,`CREATE VIEW IF NOT EXISTS ff_visible_videos AS SELECT v.* FROM ff_videos v WHERE NOT EXISTS(SELECT 1 FROM ff_video_trash t WHERE t.channel_id=v.channel_id AND t.video_id=v.id)`);
  await run(env.DB,`CREATE VIEW IF NOT EXISTS ff_visible_reports AS SELECT r.* FROM ff_reports r WHERE NOT EXISTS(SELECT 1 FROM ff_video_trash t WHERE t.channel_id=r.channel_id AND t.video_id=r.video_id)`);
}
export function pacificDay(value:string|number=Date.now()){
  const date=new Date(value);if(!Number.isFinite(+date))throw new AppError(400,'发布日期未知，请同步视频目录后重试，或使用自定义日期。');
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export async function lifetimePeriod(env:Env,cid:string,vid?:string,end=pacificDay()){
  const row=vid?await one(env.DB,'SELECT published_at FROM ff_visible_videos WHERE channel_id=? AND id=?',cid,vid):await one(env.DB,"SELECT min(published_at) published_at FROM ff_visible_videos WHERE channel_id=? AND published_at!=''",cid);
  if(!row?.published_at)throw new AppError(400,'发布日期未知，请先同步视频目录，或选择自定义日期。');
  return dates(pacificDay(row.published_at),end);
}
