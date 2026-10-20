import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { startServer } from '../src/server.mjs';
const directory = resolve(process.argv[2] ?? 'work/real-smoke');
const server = await startServer({ directory });
const bus = server.bus;
const result = {};
const group = bus.store.all('SELECT * FROM groups')[0];
const members = bus.members(group.id);
const lead = members.find(m => m.role === 'lead'), dsh = members.find(m => m.host === 'dsh'), claude = members.find(m => m.host === 'claude');
async function until(fn) { const end = Date.now() + 150000; while (!fn()) { if (Date.now() > end) throw new Error('scenario timed out'); await new Promise(resolve => setTimeout(resolve, 100)); } }
let peakDshPairTurns = 0;
const sampler = setInterval(() => { peakDshPairTurns = Math.max(peakDshPairTurns, [...bus.running.values()].filter(x => x.endpoint.member_id === dsh.id && x.endpoint.context.startsWith('pair:')).length); }, 25);
try {
  await bus.runEndpoint(bus.store.endpoint(claude.id, 'profile'), '这是当前轮的通信验收。只用 note 给主 Agent 留言 NOTE_REAL_916，不要发正式消息，不要修改文件，结束本回合。');
  const note = bus.store.get("SELECT * FROM messages WHERE kind='note' AND text LIKE '%NOTE_REAL_916%' ORDER BY seq DESC");
  if (!note) throw new Error('真实留言没有生成');
  result.noteDidNotWake = !bus.store.get('SELECT 1 FROM attached WHERE message_id=?', note.id);
  await Promise.all([
    bus.privateTurn(group.id, '这是新的通信验收。只通过 send 给 DSH 发送：请只通过 send 给主 Agent 回复 ACK_LEAD_916，不要发其他消息，不要修改文件。发出后结束。'),
    bus.runEndpoint(bus.store.endpoint(claude.id, `pair:${dsh.id}`, dsh.id), '这是当前轮的通信验收。只通过 send 给 DSH 发送：请只通过 send 给 Claude 回复 ACK_CLAUDE_916，不要发其他消息，不要修改文件。发出后结束。'),
  ]);
  await until(() => bus.store.all("SELECT text FROM messages WHERE sender=? AND kind='send'", dsh.id).some(m => m.text.includes('ACK_CLAUDE_916')) && bus.store.all("SELECT text FROM messages WHERE sender=? AND kind='send'", dsh.id).some(m => m.text.includes('ACK_LEAD_916')) && bus.running.size === 0);
  const attached = bus.store.get('SELECT o.payload FROM attached a JOIN outbox o ON o.id=a.outbox_id WHERE a.message_id=?', note.id);
  const envelope = JSON.parse(attached.payload);
  result.noteWithDifferentSender = envelope.message.sender === dsh.id && envelope.notes.some(n => n.id === note.id && n.sender === claude.id);
  result.independentDshContexts = bus.store.all("SELECT id,peer,session FROM endpoints WHERE member_id=? AND context LIKE 'pair:%'", dsh.id);
  result.multiplePairSessions = result.independentDshContexts.length >= 2 && new Set(result.independentDshContexts.map(x => x.session)).size >= 2;
  result.peakDshPairTurns = peakDshPairTurns;
  result.summary = await bus.privateTurn(group.id, '请通过 read 查看本轮编号包含 916 的正式消息和留言，向用户汇总。不要发送群消息或修改文件。');
  result.passed = result.noteDidNotWake && result.noteWithDifferentSender && result.multiplePairSessions && result.summary.includes('NOTE_REAL_916') && result.summary.includes('ACK_LEAD_916') && result.summary.includes('ACK_CLAUDE_916');
} catch (error) { result.error = error.stack; result.passed = false; }
finally { clearInterval(sampler); await server.close(); writeFileSync(resolve(directory, 'scenarios-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1; }
