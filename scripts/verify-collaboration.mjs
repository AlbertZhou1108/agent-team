// Explicitly isolated real-host acceptance. Never opens an existing directory.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startServer } from '../src/server.mjs';

const directory = mkdtempSync(resolve('work/collaboration-acceptance-'));
const workspace = join(directory, 'project'); mkdirSync(workspace);
const result = { directory, workspace, started: new Date().toISOString(), scenarios: [] };
let server;
const persist = () => writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2));
async function until(fn, ms = 420000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('隔离验收超时'); await new Promise(r => setTimeout(r, 250)); }
}
const contract = (goal, policy = 'communication') => ({ goal, scope: '仅限本次隔离验收项目，成员使用团队工具交流', boundary: '禁止部署、提交Git、外部发送、访问其他项目；只修改获准的验收项目文件', confirmation: '目标、范围、授权变化或无法明确推导的重要决定必须由用户确认', delivery: '按目标提供结果、消息证据、审查和真实结束状态', criteria: [goal], policy, allowShell: false });
async function team(name, goal, policy) {
  let p = server.bus.prepareGroup({ name, workspace, lead: { name: '主 Agent', host: 'codex' }, members: [{ name: '执行者', host: 'dsh' }, { name: '审查者', host: 'claude' }] });
  p = server.bus.collaboration.propose(p.id, contract(goal, policy), p.revision);
  const group = server.bus.confirmPreparation(p.id, p.revision, p.hash);
  const record = { name, group: group.id, contract: p.contract, approvedRevision: p.revision, approvedHash: p.hash };
  result.scenarios.push(record); persist();
  await until(() => !server.bus.running.size, 180000);
  assert(server.bus.members(group.id).every(m => m.profile), '真实宿主入群自述失败');
  return { group, record };
}
async function complete(group, record, directive) {
  server.bus.directive(group.id, directive);
  await until(() => server.bus.collaboration.state(group.id).phase === 'closed');
  record.state = server.bus.collaboration.read(group.id);
  assert.equal(record.state.state.outcome, 'completed');
  assert(record.state.items.some(i => i.state === 'accepted'));
  assert.equal(record.state.pendingMessages.length, 0);
  assert.equal(record.state.runningCount, 0);
  record.messages = server.bus.store.all('SELECT * FROM messages WHERE group_id=?', group.id);
  record.policies = server.bus.store.all("SELECT h.event FROM history h JOIN endpoints e ON e.id=h.endpoint_id WHERE e.group_id=? AND h.event LIKE '%framework.policy%'", group.id).map(r => JSON.parse(r.event));
  record.hostMessages = server.bus.store.all('SELECT p.host,COUNT(*) AS count FROM messages m JOIN members p ON p.id=m.sender WHERE m.group_id=? AND m.kind=? GROUP BY p.host', group.id, 'send');
  record.sessionBindings = server.bus.store.all('SELECT e.member_id,e.context,b.session_key,b.session FROM endpoint_session_bindings b JOIN endpoints e ON e.id=b.endpoint_id WHERE e.group_id=? ORDER BY e.member_id,b.session_key', group.id);
  for (const host of ['codex', 'dsh', 'claude']) assert(record.hostMessages.some(row => row.host === host && row.count > 0), `${host} 缺少真实发送消息证据`);
  const modes = record.policies.map(policy => [policy.host, policy.requested.mode]);
  for (const [host, mode] of Object.entries(record.contract.policy === 'communication'
    ? { codex: 'communication', dsh: 'communication', claude: 'communication' }
    : { codex: 'communication', dsh: 'workspace-write', claude: 'read-only' })) {
    assert(modes.some(([observedHost, observedMode]) => observedHost === host && observedMode === mode), `${host} 未出现预期 ${mode} 策略`);
  }
  persist();
}
try {
  server = await startServer({ directory });
  result.panelUrl = server.url;
  server.bus.on('notice', m => { console.error(m.text); });
  const discussion = await team('纯讨论验收', '给出停止团队讨论的两条判断依据并由独立审查者检查');
  await complete(discussion.group, discussion.record, '执行目标契约：请建立一个多人工作项，执行者给出两条停止讨论的判断依据，审查者独立检查是否可操作。你负责派发、引用实际汇报和审查消息、接受成果、覆盖完成条件并调用team_finish交付。使用communication策略，不读写项目文件。不要只是向用户描述计划；实际使用工具推进。工具创建工作项也需要note理由。成果可用明确的文本版本标识。需要等待必要汇报时直接结束本回合，不要调用子 Agent、wait 或任何原生协同工具；汇报会自动回到你的同一调度会话。接受成果后不要再给成员发礼貌性收束消息；调用collaboration_read确认pendingMessages，并在team_finish中用dispositions逐条说明处理理由。若收尾工具返回仍有未处理消息，重新读取后补齐，不要改成未完成终止。');
  console.log('DISCUSSION_OK');
  const implementation = await team('实现审查验收', '实现 normalizeNames：trim、移除空字符串、大小写不敏感去重且保留首个拼写；独立审查实际文件并验证示例', 'workspace-write');
  writeFileSync(join(workspace, 'normalize-names.mjs'), 'export const normalizeNames = names => names.map(x => x.trim()).filter(Boolean);\n');
  await complete(implementation.group, implementation.record, '执行契约。在项目中已有normalize-names.mjs初稿，尚未按大小写不敏感去重。创建一个多人工作项，明确 policy=workspace-write、allowShell=false：执行者先读取并汇报初稿，审查者应自动收窄为只读并独立检查实际文件指出缺陷；随后执行者返工实现目标并验证示例；审查者重新读取并审查最终文件。你记录明确的成果版本、对应汇报与审查消息、理由，独立判断接受和收尾。不要自己代替执行者修改或代替审查者给结论。仅允许修改该项目内的normalize-names.mjs及必要测试文件。禁止Git提交部署。沟通使用send，任务消息带workItemId。不需要致谢或无限重复复查。等待时直接结束本回合，不要调用子 Agent、wait 或任何原生协同工具。接受成果后不要再给成员发礼貌性收束消息；调用collaboration_read确认pendingMessages，并在team_finish中用dispositions逐条说明处理理由。若收尾工具返回仍有未处理消息，重新读取后补齐。');
  const module = await import(`file://${join(workspace, 'normalize-names.mjs')}?t=${Date.now()}`);
  assert.deepEqual(module.normalizeNames([' A ', 'a', '', 'B', ' b ']), ['A', 'B']);
  implementation.record.artifact = readFileSync(join(workspace, 'normalize-names.mjs'), 'utf8');
  console.log('IMPLEMENTATION_OK');
  const impossible = await team('必要证据缺失验收', '依据不存在的用户签字验收材料作出验收结论');
  server.bus.directive(impossible.group.id, '目标要求用户签字验收材料，但材料未提供且不得虚构。请建立工作项并让执行者核实缺失，必要时审查者检查。保留blocked并发起需要用户决定的提案，不能自行放宽完成条件或宣布完成。等待用户，不要重复讨论。');
  await until(() => {
    const s = server.bus.collaboration.read(impossible.group.id);
    return !server.bus.running.size && s.items.some(i => i.state === 'blocked');
  });
  impossible.record.beforeTermination = server.bus.collaboration.read(impossible.group.id);
  assert.equal(impossible.record.beforeTermination.state.phase, 'active');
  await server.bus.terminate(impossible.group.id, '隔离测试用户确认材料缺失，结束本次无法完成的验收');
  impossible.record.state = server.bus.collaboration.read(impossible.group.id);
  assert.equal(impossible.record.state.state.outcome, 'incomplete');
  assert(impossible.record.state.items.some(i => i.state === 'blocked'));
  console.log('BLOCKED_OK');
  result.passed = true;
} catch (e) { result.error = e.stack; result.passed = false; process.exitCode = 1; }
finally {
  if (server) {
    for (const s of result.scenarios) s.lastState = server.bus.collaboration.read(s.group);
    await server.close();
  }
  result.finished = new Date().toISOString(); persist();
  console.log(JSON.stringify({ directory, passed: result.passed, error: result.error }));
}
