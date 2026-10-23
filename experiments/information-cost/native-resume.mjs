import {createCodexHost} from '../../src/hosts/codex.mjs';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'information-resume-')),host=createCodexHost({}),results=[];
let session=null,previousPolicy;
try{
 const catalog=await host.listModels(); if(!catalog.models.some(m=>m.id==='gpt-6-luna')) throw Error('Luna unavailable; no fallback allowed');
 for(const revision of [1,2,3]){
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),90000);
 try{
 const text=await host.run({endpoint:{id:'resume-experiment',key:'synthetic',session},workspace:dir,turnId:`r${revision}`,prompt:revision===3?'本轮权威动态状态 CURRENT_CODE=REV_3_ONLY，覆盖历史值和旧规则值。只输出本轮权威状态中的 CURRENT_CODE 值。':'只输出当前规则中的 CURRENT_CODE 值。',instructions:`CURRENT_CODE=REV_${revision}_ONLY。若历史中存在旧值，只使用本次规则。`,tools:[],policy:{mode:'communication',allowShell:false},previousPolicy,modelSelection:{model:'gpt-6-luna',reasoning_effort:'low'},signal:abort.signal,onSession(x){session=x},onPolicy(x){previousPolicy=x},onAccepted(){},onNativeTurn(){},onEvent(){},onModel(){},onTool:async()=>{throw Error('no tools')},onTelemetry(){}});
 results.push({revision,text,passed:text.trim()===`REV_${revision}_ONLY`,sameSession:revision>1&&Boolean(session)});
 }catch(e){results.push({revision,error:e.message});break}finally{clearTimeout(timer)}
 }
// Separate control: stable developer instructions explicitly delegate current facts to each turn.
 session=null;previousPolicy=undefined;
 for(const revision of [1,2]) {
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),90000);
 try {const text=await host.run({endpoint:{id:'stable-rules-control',key:'synthetic',session},workspace:dir,turnId:`stable-${revision}`,prompt:`本轮权威动态状态 CURRENT_CODE=STATE_${revision}。只输出该值。`,instructions:'规则固定：CURRENT_CODE 是动态事实，每轮以该轮输入中的权威状态为准，旧轮输入中的值已过期。',tools:[],policy:{mode:'communication',allowShell:false},previousPolicy,modelSelection:{model:'gpt-6-luna',reasoning_effort:'low'},signal:abort.signal,onSession(x){session=x},onPolicy(x){previousPolicy=x},onAccepted(){},onNativeTurn(){},onEvent(){},onModel(){},onTool:async()=>{throw Error('no tools')},onTelemetry(){}});results.push({control:'stable-rules-turn-facts',revision,text,passed:text.trim()===`STATE_${revision}`,sameSession:revision>1});}
 catch(e){results.push({control:'stable-rules-turn-facts',revision,error:e.message});break}finally{clearTimeout(timer)}
 }
}finally{await host.close();rmSync(dir,{recursive:true,force:true});writeFileSync(new URL('./native-resume-luna-results.json',import.meta.url),JSON.stringify(results,null,2));console.log(JSON.stringify(results));}
