import {createDshHost,createClaudeHost} from '../../src/hosts/cli-hosts.mjs';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import net from 'node:net';
const directory=mkdtempSync(join(tmpdir(),'info-hosts-')),socketPath=join(directory,'test.sock'),results=[];
let activeReads=[];
const source='开始\n'+'PASS\n'.repeat(120)+'FAIL E_HIDDEN_52\n'+'PASS\n'.repeat(120)+'结束';
const tools=[{name:'read',description:'读取唯一日志完整原文。预览不完整，判断必须依据完整原文。',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
const server=net.createServer(s=>{let text='';s.on('data',b=>{text+=b;if(!text.includes('\n'))return;try{const r=JSON.parse(text.split('\n')[0]);if(r.key!=='test-key')throw Error('bad key');const value=r.op==='tools'?tools:r.op==='tool'&&r.name==='read'?(activeReads.push('read'),{text:source}):(()=>{throw Error('unsupported')})();s.end(JSON.stringify({result:value})+'\n');}catch(e){s.end(JSON.stringify({error:e.message})+'\n')}})});
await new Promise(r=>server.listen(socketPath,r));
const catalogs=JSON.parse(readFileSync(new URL('./host-catalog-results.json',import.meta.url)));
try{for(const [name,create] of [['dsh',createDshHost],['claude',createClaudeHost]])for(const variant of ['full','selective']){
 const host=create({directory,socketPath});const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),90000);activeReads=[];const models=[],telemetry=[];const started=Date.now();
 const catalog=catalogs.find(x=>x.host===name)?.catalog;const selected=catalog?.models.find(m=>m.key===catalog.defaultModel||m.id===catalog.defaultModel);
 try{const output=await host.run({endpoint:{id:`${name}-${variant}`,key:'test-key',session:null},workspace:directory,turnId:`${name}-${variant}`,prompt:'只有零失败可接受。返回JSON {"accept":boolean,"evidence":string}，evidence填错误码，无错误填NONE。\n'+(variant==='full'?source:'日志预览：开始，结束。全文可用read工具读取，预览不包含中间内容。'),instructions:'隔离验证，只分析合成日志，不读写项目文件。最终只输出要求的JSON。',tools:variant==='selective'?tools:[],policy:{mode:'communication',allowShell:false},modelSelection:selected?{model:selected.id,model_provider:selected.provider}:undefined,signal:abort.signal,onSession(){},onAccepted(){},onNativeTurn(){},onEvent(){},onModel(x){models.push(x)},onTelemetry(x){telemetry.push(x)}});
 let parsed;try{parsed=JSON.parse(output.replace(/^```json\s*|\s*```$/g,''))}catch{}
 results.push({host:name,variant,output,passed:parsed?.accept===false&&parsed?.evidence==='E_HIDDEN_52',reads:[...activeReads],models,telemetry,elapsedMs:Date.now()-started});
 }catch(e){results.push({host:name,variant,error:e.message,models,elapsedMs:Date.now()-started})}finally{clearTimeout(timer);await host.close?.()}
 writeFileSync(new URL('./cross-host-results.json',import.meta.url),JSON.stringify(results,null,2));console.log(JSON.stringify({...results.at(-1),models:undefined,telemetry:undefined}));
}}finally{await new Promise(r=>server.close(r));rmSync(directory,{recursive:true,force:true})}
