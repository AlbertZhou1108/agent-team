// A global execution view: never add message-source attribution subtotals.
export function telemetryOverview(bus, { from, to, bucket = 'day' } = {}) {
  const end = to ? Date.parse(to) : Date.now();
  const start = from ? Date.parse(from) : end - 7 * 86400000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 31 * 86400000) throw new Error('统计区间须有效且不超过31天');
  if (!['hour', 'day'].includes(bucket)) throw new Error('分桶仅支持 hour 或 day');
  const width = bucket === 'hour' ? 3600000 : 86400000;
  const groups = bus.store.all('SELECT * FROM groups ORDER BY created');
  const liveRuns = [...bus.running.values()].filter(r => ['coordination','panel-coordination'].includes(r.endpoint?.context) || r.endpoint?.context?.startsWith('pair:'));
  const seen = new Set();
  const all = [];
  const teams = groups.map(group => {
    const batches = bus.telemetry._batches(group.id).filter(batch => {
      const time = Date.parse(batch.startedAt);
      if (time < start || time >= end || !Number.isFinite(time) || seen.has(batch.batchId)) return false;
      seen.add(batch.batchId);return true;
    });
    all.push(...batches);
    const expected = bus.store.get(`SELECT COUNT(*) AS count FROM turns t JOIN endpoints e ON e.id=t.endpoint_id
      WHERE e.group_id=? AND (e.context='coordination' OR e.context LIKE 'pair:%') AND t.created>=? AND t.created<?`, group.id, new Date(start).toISOString(), new Date(end).toISOString()).count
      + bus.store.get(`SELECT COUNT(*) AS count FROM panel_turns WHERE group_id=? AND context='coordination' AND created>=? AND created<?`,group.id,new Date(start).toISOString(),new Date(end).toISOString()).count;
    const tokenBatches=batches.filter(b=>b.metrics.totalTokens.value!==null).length;
    const unknown=bus.collaboration.unknown(group.id).length+bus.panelUnknown(group.id).length;
    const running=liveRuns.filter(r=>r.endpoint.group_id===group.id).length;
    const status=group.state==='archived'?'archived':unknown?'blocked':running?'running':'waiting';
    return {id:group.id,name:group.name,status,batchCount:batches.length,expectedTurns:expected,tokenBatches,metrics:bus.telemetry._sumBatches(batches)};
  });
  const expectedTurns=teams.reduce((n,t)=>n+t.expectedTurns,0);
  const tokenBatches=teams.reduce((n,t)=>n+t.tokenBatches,0);
  const totals=bus.telemetry._sumBatches(all);
  const missingTurns=Math.max(0,expectedTurns-tokenBatches);
  if(missingTurns)for(const metric of Object.values(totals))if(metric.value!==null)metric.completeness='partial';
  const series=Array.from({length:Math.ceil((end-start)/width)},(_,i)=>{
    const a=start+i*width,b=Math.min(end,a+width);
    const samples=all.filter(batch=>{const t=Date.parse(batch.startedAt);return t>=a&&t<b});
    return{from:new Date(a).toISOString(),to:new Date(b).toISOString(),batchCount:samples.length,metrics:bus.telemetry._sumBatches(samples)};
  });
  return{range:{from:new Date(start).toISOString(),to:new Date(end).toISOString(),bucket},generatedAt:new Date().toISOString(),
    scope:'全部团队的共享执行回合，包含归档团队；不包含私人、准备和profile会话',timeBasis:'回合开始时间；区间左闭右开；hour/day为从区间起点开始的固定1/24小时',
    counts:{teams:groups.length,members:bus.store.get('SELECT COUNT(*) AS count FROM members WHERE removed IS NULL').count,running:liveRuns.length},
    totals,coverage:{expectedTurns,tokenBatches,missingTurns},teams,series,
    states:Object.entries(teams.reduce((out,t)=>{out[t.status]=(out[t.status]??0)+1;return out},{})).map(([state,count])=>({state,count}))};
}
