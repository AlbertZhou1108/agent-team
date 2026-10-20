import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startServer } from '../src/server.mjs';
const directory = resolve(process.argv[2] ?? `work/smoke-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const result = { directory, started: new Date().toISOString(), checks: {} };
let server;
async function until(predicate, timeout = 150000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('真实宿主等待超时'); await new Promise(resolve => setTimeout(resolve, 200)); }
}
const notices = [];
try {
  server = await startServer({ directory });
  server.bus.on('notice', notice => { notices.push(notice.text); console.error(notice.text); });
  const group = server.bus.createGroup({ name: 'CLI 三宿主验收', workspace: directory, lead: { name: '主 Agent', host: 'codex' }, members: [{ name: 'DSH', host: 'dsh' }, { name: 'Claude', host: 'claude' }] });
  result.group = group.id;
  await until(() => server.bus.members(group.id).every(member => member.profile) && server.bus.running.size === 0);
  result.checks.profiles = true; console.log('PROFILES_OK');
  const sentinel = 'PRIVATE_ONLY_AGENT_TEAM_482';
  result.privateAnswer = await server.bus.privateTurn(group.id, `这是框架验收，禁止修改文件或使用任何非群工具。用户私聊标记 ${sentinel} 不能转发。分别用 send 给 DSH 和 Claude 发以下要求：这是一次通信验收，请只通过 send 给主 Agent 回复 DSH_ACK_482（Claude 则回复 CLAUDE_ACK_482），不要发其他消息，不要修改文件。你向用户简单报告已发送即可。`);
  await until(() => server.bus.store.all("SELECT * FROM messages WHERE kind='send'").some(m => m.text.includes('DSH_ACK_482') && m.sender !== group.lead) && server.bus.store.all("SELECT * FROM messages WHERE kind='send'").some(m => m.text.includes('CLAUDE_ACK_482') && m.sender !== group.lead) && server.bus.running.size === 0);
  result.checks.crossHostReplies = true; console.log('REPLIES_OK');
  result.summary = await server.bus.privateTurn(group.id, '请调用 read 读取本群消息，向用户汇总 DSH 和 Claude 各自实际回复了什么。不要发送群消息或修改文件。');
  if (!result.summary.includes('DSH_ACK_482') || !result.summary.includes('CLAUDE_ACK_482')) throw new Error('汇总缺少实际回复');
  result.checks.privateSummary = true;
  result.checks.privateNotStored = !JSON.stringify(server.bus.store.all('SELECT * FROM messages')).includes(sentinel) && !JSON.stringify(server.bus.store.all('SELECT * FROM history')).includes(sentinel);
  if (!result.checks.privateNotStored) throw new Error('私聊标记进入框架群记录');
  result.members = server.bus.members(group.id).map(({ id, name, host, profile }) => ({ id, name, host, profile }));
  result.messages = server.bus.store.all('SELECT * FROM messages');
  await server.close(); server = null;
  server = await startServer({ directory });
  result.restartSummary = await server.bus.privateTurn(group.id, '这是重启后的会话验证。请调用 read，再次向用户报告 DSH 和 Claude 的验收回复编号。不要发送群消息或修改文件。');
  if (!result.restartSummary.includes('DSH_ACK_482') || !result.restartSummary.includes('CLAUDE_ACK_482')) throw new Error('重启恢复后的读取或会话工具不可用');
  result.checks.restartAndResumeTools = true;
  result.checks.noUnexpectedFailure = notices.length === 0;
  result.notices = notices;
  result.passed = Object.values(result.checks).every(Boolean);
} catch (error) { result.error = error.stack; result.passed = false; }
finally {
  if (server) await server.close();
  result.finished = new Date().toISOString();
  writeFileSync(resolve(directory, 'smoke-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
