import {createServer} from 'node:http';
import {openArchive} from './archive.mjs';
import {createClient} from './source.mjs';
import {collect} from './reader.mjs';
import {initialStreamState, ingestStream, listPending, streamStatus} from './stream.mjs';

export async function startIntake({origin,directory,port=0}) {
  const archive=await openArchive(directory);
  // 同一归档同一时刻只能跑一轮连续接收，避免并发投递重复建件
  let ingestLock=Promise.resolve();
  const server=createServer(async (request,response)=>{
    const send=(value,status=200)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));};
    try {
      const path=new URL(request.url,'http://localhost').pathname;
      if(request.method==='GET'&&path==='/health'){send({status:'运行中'});return;}
      if(request.method==='GET'&&path==='/records'){send(archive.records());return;}
      if(request.method==='GET'&&path==='/receipts'){send(archive.exchanges());return;}
      if(request.method==='GET'&&path==='/devices'){const state=archive.stream();send(state===null?[]:state.devices);return;}
      if(request.method==='GET'&&path==='/pending'){const state=archive.stream();send(state===null?[]:listPending(state));return;}
      if(request.method==='GET'&&path==='/stream'){const state=archive.stream();send(state===null?streamStatus(initialStreamState()):streamStatus(state));return;}
      if(request.method==='POST'&&path==='/collect'){
        const client=createClient(origin);const records=await collect(client);
        send(await archive.commit(records,client.exchanges));return;
      }
      if(request.method==='POST'&&path==='/ingest'){
        let release;
        const turn=new Promise(resolve=>{release=resolve;});
        const previous=ingestLock;
        ingestLock=previous.then(()=>turn,()=>turn);
        await previous.catch(()=>{});
        try {
          // 状态在内存中克隆推演，成功后原子落盘；失败不污染已持久化水位
          const state=archive.stream()??initialStreamState();
          const client=createClient(origin);
          const summary=await ingestStream(client,state);
          if(summary.fetchedRecords===0){
            send({...summary,committed:false});
          }else{
            const receipt=await archive.commitStream(state,client.exchanges.filter(exchange=>exchange.status>=200&&exchange.status<300));
            send({...summary,committed:true,receipt});
          }
        } finally { release(); }
        return;
      }
      send({message:'接口不存在'},404);
    } catch(error){send({message:error.message},error.status>=400&&error.status<500?error.status:502);}
  });
  await new Promise(resolve=>server.listen(port,'0.0.0.0',resolve));
  return {origin:`http://127.0.0.1:${server.address().port}`,archive,close:()=>new Promise(resolve=>server.close(resolve))};
}
