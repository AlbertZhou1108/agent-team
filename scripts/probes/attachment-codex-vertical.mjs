// Verification-only upload sidecar and native-input seam. Not a production API.
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { startServer } from '../../src/server.mjs';
import { createCodexHost } from '../../src/hosts/codex.mjs';
const root = process.env.ATTACHMENT_PROBE_ROOT ?? mkdtempSync(join(tmpdir(), 'attachment-codex-vertical-'));
const data=join(root,'data'), workspace=join(root,'workspace'), files=join(workspace,'attachments');
mkdirSync(files,{recursive:true});mkdirSync(data,{recursive:true});
const manifestFile=join(root,'manifest.json');
const load=()=>existsSync(manifestFile)?JSON.parse(readFileSync(manifestFile)):{};
const results=[];let app,gateway;
const log=(kind,value)=>writeFileSync(join(root,`${kind}.jsonl`),JSON.stringify(value)+'\n',{flag:'a'});
const fixtures=join(root,'source');mkdirSync(fixtures,{recursive:true});
function png(colors){
 const width=360,height=240;const raw=Buffer.alloc((width*3+1)*height,255);
 const palette={red:[255,0,0],blue:[0,0,255],green:[0,160,0],yellow:[255,220,0],purple:[160,0,180],orange:[255,130,0]};
 for(let y=0;y<height;y++){raw[y*(width*3+1)]=0;for(let x=0;x<width;x++){const c=palette[colors[Math.floor(y/120)*3+Math.floor(x/120)]];for(let k=0;k<3;k++)raw[y*(width*3+1)+1+x*3+k]=c[k];}}
 function crc(b){let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
 function chunk(t,b){const name=Buffer.from(t),n=Buffer.alloc(4),sum=Buffer.alloc(4);n.writeUInt32BE(b.length);sum.writeUInt32BE(crc(Buffer.concat([name,b])));return Buffer.concat([n,name,b,sum]);}
 const ih=Buffer.alloc(13);ih.writeUInt32BE(width);ih.writeUInt32BE(height,4);ih[8]=8;ih[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const colors=['red','blue','green','yellow','purple','orange'];
function shuffle(){return [...colors].map(c=>({c,n:randomBytes(4).readUInt32BE()})).sort((a,b)=>a.n-b.n).map(x=>x.c);}
const expected={text:randomBytes(12).toString('hex'),first:shuffle(),second:shuffle()};
writeFileSync(join(fixtures,'sample.txt'),'Verification secret: '+expected.text+'\n');
writeFileSync(join(fixtures,'sample.png'),png(expected.first));writeFileSync(join(fixtures,'second.png'),png(expected.second));
writeFileSync(join(root,'expected.json'),JSON.stringify(expected,null,2));
async function boot(native=false){
 let factory=createCodexHost;
 if(native){
  // Execute the real adapter with exactly one input mapping replaced, in a scratch copy.
  const original=new URL('../../src/hosts/codex.mjs',import.meta.url);
  let source=readFileSync(original,'utf8');
  const needle="input: [{ type: 'text', text: prompt }]";
  if(!source.includes(needle))throw Error('Adapter seam changed; inspect before rerunning');
  source=source.replace(needle,"input: [{ type: 'text', text: prompt }, ...(context.probeImages ?? []).map(path => ({ type: 'localImage', path }))]");
  source=source.replace(/from '(\.\.?\/[^']+)'/g,(_,specifier)=>`from '${new URL(specifier,original).href}'`);
  const copy=join(root,'codex-native-input-prototype.mjs');writeFileSync(copy,source);
  factory=(await import(pathToFileURL(copy).href)).createCodexHost;
 }
 const host=factory({reasoningEffort:'low'});const run=host.run.bind(host);
 host.run=async context=>{
  const current=load();const ids=[...context.prompt.matchAll(/\[attachment:([a-f0-9-]+)\]/g)].map(m=>m[1]);
  log('calls',{native,policy:context.policy,session:context.endpoint.session,attachmentIds:ids});
  if(native)context.probeImages=ids.map(id=>current[id]).filter(a=>a?.type==='image/png').map(a=>a.path);
  const event=context.onEvent;context.onEvent=row=>{log('events',row);event(row)};
  return run(context);
 };
 app=await startServer({directory:data,hosts:new Map([['codex',host]])});
 gateway=http.createServer(async(req,res)=>{try{
  if(req.method==='POST'&&req.url==='/upload'){
   const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);
   if(bytes.length>1024*1024){res.writeHead(413);res.end('too large');return;}
   const type=req.headers['content-type'];if(!['text/plain','image/png'].includes(type)){res.writeHead(415);res.end('unsupported');return;}
   if(type==='image/png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){res.writeHead(422);res.end('invalid png signature');return;}
   const id=randomUUID(),path=join(files,id+(type==='image/png'?'.png':'.txt'));writeFileSync(path,bytes);
   const item={id,path,type,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};const manifest=load();manifest[id]=item;writeFileSync(manifestFile,JSON.stringify(manifest,null,2));
   res.setHeader('content-type','application/json');res.end(JSON.stringify(item));return;
  }
  if(req.method==='POST'&&req.url==='/send'){
   const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));const manifest=load();
   const attachments=(body.ids??[]).map(id=>{if(!manifest[id]||!existsSync(manifest[id].path))throw Error('unknown or missing attachment');return manifest[id]});
   const text=body.text+'\n'+attachments.map(a=>`[attachment:${a.id}] ${a.type} ${a.path}`).join('\n');
   const url=new URL('/api/panel-agent/messages',app.url);const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',origin:new URL(app.url).origin},body:JSON.stringify({text})});
   res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());return;
  }res.writeHead(404);res.end();
 }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error.message}));}});
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${gateway.address().port}`;
}
async function shutdown(){if(gateway)await new Promise(r=>gateway.close(r));gateway=null;if(app)await app.close();app=null;}
async function post(base,path,body,type='application/json'){const res=await fetch(base+path,{method:'POST',headers:{'content-type':type},body:type==='application/json'?JSON.stringify(body):body,signal:AbortSignal.timeout(150000)});const text=await res.text();let value;try{value=JSON.parse(text)}catch{value=text}return {status:res.status,value};}
async function send(base,name,ids,text){const result=await post(base,'/send',{ids,text:'Verification only. Read only the explicitly attached files. No other files or actions. '+text});results.push({name,...result});log('results',results.at(-1));console.log(JSON.stringify({name,status:result.status,result:result.value?.result??result.value}));return result;}
try{
 let base=await boot(false);
 if(!app.bus.panelAgent()){
  const catalogs=await app.bus.modelCatalog({refresh:true});const c=catalogs.hosts.find(h=>h.host==='codex').catalog;const m=c.models.find(m=>m.isDefault)??c.models[0];
  await app.bus.createPanelAgent({name:'Attachment verification',host:'codex',model:m.id,reasoning_effort:m.defaultReasoningEffort??'low',workspace,access:'read-only'});
  log('model',{selected:m.id});
 }
 const txt=await post(base,'/upload',readFileSync(join(fixtures,'sample.txt')),'text/plain');
 const image=await post(base,'/upload',readFileSync(join(fixtures,'sample.png')),'image/png');
 const second=await post(base,'/upload',readFileSync(join(fixtures,'second.png')),'image/png');
 results.push({name:'uploads',txt,image,second});log('results',results.at(-1));
 await send(base,'actual-adapter-text',[txt.value.id],'Return the exact verification secret from the attached TXT.');
 await send(base,'actual-adapter-image-path',[image.value.id],'Return all six cell colors in row-major order of the PNG. If inaccessible say UNAVAILABLE. Do not use OCR or install tools.');
 const bad=await post(base,'/upload',Buffer.from('bad png'),'image/png');results.push({name:'bad-upload',...bad});log('results',results.at(-1));
 const unknown=await post(base,'/send',{ids:[randomUUID()],text:'read'});results.push({name:'unknown-id',...unknown});log('results',results.at(-1));
 await shutdown();base=await boot(false);
 await send(base,'restart-durable-text',[txt.value.id],'Re-read the TXT through a file tool. Return its exact secret and byte length. Do not answer from memory.');
 await shutdown();base=await boot(true);
 await send(base,'native-seam-image',[second.value.id],'Read the attached image directly. Return all six cell colors in row-major order. Do not use file tools.');
 await shutdown();base=await boot(true);
 await send(base,'native-seam-restart',[image.value.id],'Read the newly attached image directly, return all six cell colors in row-major order. Do not use tools.');
 const state=app.bus.panelBrowserState();writeFileSync(join(root,'persisted-panel-summary.json'),JSON.stringify({agent:state.agent,conversation:state.conversation},null,2));
 const byName=name=>results.find(r=>r.name===name);
 assert.equal(byName('actual-adapter-text').status,200);assert.ok(byName('actual-adapter-text').value.result.includes(expected.text));
 assert.equal(byName('restart-durable-text').status,200);assert.ok(byName('restart-durable-text').value.result.includes(expected.text));
 assert.equal(byName('bad-upload').status,422);assert.equal(byName('unknown-id').status,400);
 function checkColors(name,colors){const r=byName(name);assert.equal(r.status,200);const observed=(r.value.result.toLowerCase().match(/red|blue|green|yellow|purple|orange/g)??[]);assert.deepEqual(observed,colors);}
 checkColors('actual-adapter-image-path',expected.first);checkColors('native-seam-image',expected.second);checkColors('native-seam-restart',expected.first);
 for(const a of Object.values(load()))assert.equal(createHash('sha256').update(readFileSync(a.path)).digest('hex'),a.sha256);
 writeFileSync(join(root,'assertions.json'),JSON.stringify({txt:true,restartReread:true,pathImage:true,nativeImages:true,badUploadRejected:true,unknownIdRejected:true,storedHashesUnchanged:true},null,2));
 writeFileSync(join(root,'summary.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({root,manifest:manifestFile}));
}catch(error){console.error(error);process.exitCode=1;}finally{await shutdown();}
