// Candidate information boundary. Not wired into production tools.
import {createHash} from 'node:crypto';
const hash=text=>createHash('sha256').update(text).digest('hex');
const size=value=>Buffer.byteLength(JSON.stringify(value));
export function projectFacts({goal,artifact,rows,constraints,unknown=[],pending=[]},budget=16384){
 if(!goal||!artifact||!Array.isArray(rows))throw Error('explicit identity required');
 const relevant=rows.filter(r=>r.goal===goal&&r.artifact===artifact);
 const unresolved=rows.filter(r=>!r.goal||(r.goal===goal&&!r.artifact));
 const view={schema:1,goal,artifact,constraints,relevant,unresolved,unknown,pending,complete:true};
 // No silent trimming of unresolved identity, policy, pending responsibility or evidence.
 if(size(view)>budget)throw Error('required facts exceed budget; explicit paging or direct full read required');
 return view;
}
export function createBoundary(bus){
 const auth=(id,key)=>{const endpoint=bus.store.authenticate(id,key);const member=bus.store.member(endpoint.member_id);return{endpoint,member}};
 return {
 async invoke(id,key,name,args={}){
 const {member}=auth(id,key);
 if(name==='list'){
  const raw=await bus.tool(id,key,'read',{after:args.after??0,limit:args.limit??10});
  return {...raw,messages:raw.messages.map(r=>({id:r.id,seq:r.seq,sender:r.sender,recipient:r.recipient,kind:r.kind,ref:{id:r.id,hash:hash(r.text)},preview:Array.from(r.text).slice(0,64).join(''),complete:Array.from(r.text).length<=64}))};
 }
 if(name==='expand'){
  const {ref,offset=0,limit=256}=args;
  if(!ref||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>1024)throw Error('invalid range');
  const row=bus.store.get('SELECT * FROM messages WHERE id=? AND group_id=?',ref.id,member.group_id);
  if(!row)throw Error('reference outside team or deleted');
  if(hash(row.text)!==ref.hash)throw Error('stale reference');
  const points=Array.from(row.text),end=Math.min(offset+limit,points.length);
  return{ref,text:points.slice(offset,end).join(''),offset,next:Math.min(end,points.length),hasMore:end<points.length,unit:'unicode-code-point'};
 }
 throw Error('unsupported operation');
 }
 };
}
