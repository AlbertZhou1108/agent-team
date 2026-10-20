import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { startServer } from '../src/server.mjs';
const directory = resolve(process.argv[2] ?? 'work/real-smoke');
const server = await startServer({ directory });
const { bus } = server;
const group = bus.store.all('SELECT * FROM groups')[0], members = bus.members(group.id);
const lead = members.find(m => m.role === 'lead'), claude = members.find(m => m.host === 'claude'), dsh = members.find(m => m.host === 'dsh');
const prior = bus.store.get('SELECT MAX(seq) seq FROM history').seq ?? 0;
let result = {};
try {
  const a = bus.store.endpoint(lead.id, 'private'), b = bus.store.endpoint(claude.id, `pair:${dsh.id}`, dsh.id);
  // Inject at the same authenticated tool boundary, removing model response-time differences at the senders.
  const sent = await Promise.all([bus.tool(a.id, a.key, 'send', { to: dsh.id, text: '并发验收 A：只输出 CONCURRENT_A_731，不发群消息，不使用其他工具，不修改文件。' }), bus.tool(b.id, b.key, 'send', { to: dsh.id, text: '并发验收 B：只输出 CONCURRENT_B_731，不发群消息，不使用其他工具，不修改文件。' })]);
  const end = Date.now() + 120000;
  while (true) {
    const accepted = sent.every(item => bus.store.get('SELECT o.accepted FROM attached a JOIN outbox o ON o.id=a.outbox_id WHERE a.message_id=?', item.messageId)?.accepted);
    if (accepted && bus.running.size === 0) break;
    if (Date.now() > end) throw new Error('并发验收超时');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const events = bus.store.all('SELECT h.* FROM history h JOIN endpoints e ON e.id=h.endpoint_id WHERE e.member_id=? AND h.seq>? ORDER BY h.seq', dsh.id, prior).map(row => ({ ...row, event: JSON.parse(row.event) }));
  const active = new Set(); let peak = 0;
  for (const row of events) {
    if (row.event.type === 'status' && row.event.phase === 'turn_start') active.add(row.endpoint_id);
    if (row.event.type === 'status' && row.event.phase === 'turn_end') active.delete(row.endpoint_id);
    peak = Math.max(peak, active.size);
  }
  const finals = events.filter(row => row.event.type === 'final').map(row => ({ endpoint: row.endpoint_id, text: row.event.text }));
  result = { source: 'authenticated tool-boundary injection; real DSH CLI recipient processes and native turn events', nativeConcurrentTurns: peak, finals, messageIds: sent.map(item => item.messageId), passed: peak >= 2 && finals.some(x => x.text.includes('CONCURRENT_A_731')) && finals.some(x => x.text.includes('CONCURRENT_B_731')) };
} catch (error) { result = { error: error.stack, passed: false }; }
finally { await server.close(); writeFileSync(resolve(directory, 'concurrency-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1; }
