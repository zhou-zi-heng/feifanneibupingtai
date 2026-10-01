import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialized,databaseFailure} from '../src/database';
import {person} from '../src/security';
import {AppError} from '../src/types';

const fault=(message:string)=>({DB:{prepare:()=>({bind:()=>({first:async()=>{throw new Error(message);}})})}} as any);
test('only a missing metadata table opens initial setup; quota and outages must not',async()=>{
  assert.equal(await initialized(fault('D1_ERROR: no such table: ff_meta: SQLITE_ERROR')),false);
  await assert.rejects(initialized(fault("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.")),(e:AppError)=>e.status===503&&e.code==='database_quota');
  await assert.rejects(initialized(fault('D1_ERROR: database unavailable')),(e:AppError)=>e.code==='database_unavailable');
});
test('wrapped D1 quota errors retain a useful public diagnosis without internal details',()=>{
  const e=databaseFailure(new Error('D1_ERROR',{cause:new Error("Your account has exceeded D1's free tier daily row write limit.")}));
  assert.equal(e.code,'database_quota');assert.match(e.message,/08:00/);
  assert.equal(databaseFailure(new Error('private backend exception')).message.includes('private backend'),false);
});
test('employee database quota failure is not misreported as an uninvited account',async()=>{
  const env={...fault("D1_ERROR: Your account has exceeded D1's free tier daily row read limit."),LOCAL_DEV:'true',OWNER_EMAIL:'owner@example.test'};
  const request=new Request('http://localhost/api/me',{headers:{'X-Feifan-Dev-Email':'employee@example.test'}});
  await assert.rejects(person(request,env),(e:AppError)=>e.code==='database_quota');
});
