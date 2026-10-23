import test from 'node:test';import assert from 'node:assert/strict';
// Candidate semantic filter: only appropriate when query explicitly binds both goal and artifact.
const project=(rows,goal,artifact)=>rows.filter(r=>r.goal===goal&&r.artifact===artifact);
test('explicit identity filter preserves every matching fact across 100 generated histories',()=>{
 for(let seed=0;seed<100;seed++){
  const rows=Array.from({length:2000},(_,i)=>({id:i,goal:`G${(i+seed)%7}`,artifact:`v${(i*3+seed)%11}`,status:(i+seed)%13===0?'failed':'passed'}));
  const before=JSON.stringify(rows),out=project(rows,'G2','v3');
  assert.equal(JSON.stringify(rows),before);
  const expected=rows.reduce((ids,r)=>(r.goal==='G2'&&r.artifact==='v3'?ids.push(r.id):null,ids),[]);
  assert.deepEqual(out.map(r=>r.id),expected);
  assert.deepEqual(out.filter(r=>r.status==='failed'),rows.filter(r=>r.goal==='G2'&&r.artifact==='v3'&&r.status==='failed'));
 }
});
test('missing and conflicting identity must be surfaced before using a filtered view',()=>{
 const messages=[{goal:'G2',artifact:'v3'},{goal:'G2',artifact:null},{goal:'G1',artifact:'v3'}];
 const relevant=project(messages,'G2','v3');
 assert.equal(relevant.length,1);
 // Demonstrates information discarded by a pure filter, not permission to ignore it.
 const unresolved=messages.filter(r=>r.goal==='G2'&&!r.artifact);
 assert.equal(unresolved.length,1);
 assert.notDeepEqual(relevant,messages.filter(r=>r.goal==='G2'));
});
