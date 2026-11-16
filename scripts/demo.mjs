import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startSource} from '../provider/server.mjs';
import {startIntake} from '../src/app.mjs';

const directory=await mkdtemp(join(tmpdir(),'intake-demo-'));
const source=await startSource();
const intake=await startIntake({origin:source.origin,directory});
try{
 // 连续接收：按记录保序拉取，按真实器件生命周期归集
 const ingestResponse=await fetch(intake.origin+'/ingest',{method:'POST'});
 const ingest=await ingestResponse.json();if(!ingestResponse.ok)throw new Error(JSON.stringify(ingest));
 console.log('连续接收结果',JSON.stringify(ingest));
 console.log('完结器件',JSON.stringify(await(await fetch(intake.origin+'/devices')).json(),null,2));
 console.log('未决器件',JSON.stringify(await(await fetch(intake.origin+'/pending')).json(),null,2));
 console.log('流状态',JSON.stringify(await(await fetch(intake.origin+'/stream')).json(),null,2));

 // 原有成品摘要收件能力保留
 const response=await fetch(intake.origin+'/collect',{method:'POST'});
 const receipt=await response.json();if(!response.ok)throw new Error(JSON.stringify(receipt));
 console.log('摘要收件',JSON.stringify(receipt));
 console.log('摘要资料',JSON.stringify(await(await fetch(intake.origin+'/records')).json(),null,2));
 console.log('原文凭据',JSON.stringify(await(await fetch(intake.origin+'/receipts')).json(),null,2));
}finally{await intake.close();await source.close();await rm(directory,{recursive:true,force:true});}
