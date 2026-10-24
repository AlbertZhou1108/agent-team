// Explicitly isolated real-host acceptance for the communication-first core.
// Never opens an existing directory. Completion is signalled by the lead
// agent's final text (ACCEPTANCE_DONE / ACCEPTANCE_BLOCKED), not by flow state.
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
const replies = messageId => server.bus.store.all('SELECT * FROM messages WHERE reply_to=?', messageId);
const drain = groupId => server.bus.store.pending().filter(m => m.group_id === groupId).length === 0
  && !server.bus.store.get('SELECT 1 FROM outbox WHERE accepted IS NULL AND endpoint_id IN (SELECT id FROM endpoints WHERE group_id=?)', groupId);

async function team(name, charter, policy = 'workspace-write') {
  const group = server.bus.createGroup({
    name,
    workspace,
    charter,
    policy,
    lead: { name: '主 Agent', host: 'codex' },
    members: [{ name: '执行者', host: 'dsh' }, { name: '审查者', host: 'claude' }],
  });
  const record = { name, group: group.id, charter, policy };
  result.scenarios.push(record); persist();
  await until(() => !server.bus.running.size, 180000);
  assert(server.bus.members(group.id).every(m => m.profile), '真实宿主入群自述失败');
  return { group, record };
}

async function finish(group, record, directive, doneMarker) {
  server.bus.directive(group.id, directive);
  // The directive reply only reflects the turn that received it, so poll with
  // check-in directives until the lead reports the marker or rounds run out.
  for (let round = 0; round < 24; round += 1) {
    await until(() => !server.bus.running.size && drain(group.id));
    const sent = server.bus.directive(group.id,
      round === 0
        ? `${directive} 回合结束时若尚未完成就正常结束等待汇报；全部完成后，把回合最终文本写成以 ${doneMarker} 开头的简短摘要，引用关键证据消息编号。`
        : `核对当前进展：若团队说明的任务已全部完成，把回合最终文本写成以 ${doneMarker} 开头的简短摘要并引用关键证据消息编号；否则继续推进，不要提前报告完成。`,
    );
    await until(() => replies(sent.messageId).length > 0);
    if (replies(sent.messageId).some(r => r.text.includes(doneMarker))) {
      record.rounds = round + 1;
      break;
    }
    assert.notEqual(round, 23, `验收在24轮内未收到 ${doneMarker}`);
  }
  await until(() => !server.bus.running.size && drain(group.id));
  record.messages = server.bus.store.all('SELECT * FROM messages WHERE group_id=?', group.id);
  record.policies = server.bus.store.all("SELECT h.event FROM history h JOIN endpoints e ON e.id=h.endpoint_id WHERE e.group_id=? AND h.event LIKE '%framework.policy%'", group.id).map(r => JSON.parse(r.event));
  record.hostMessages = server.bus.store.all('SELECT p.host,COUNT(*) AS count FROM messages m JOIN members p ON p.id=m.sender WHERE m.group_id=? AND m.kind=? GROUP BY p.host', group.id, 'send');
  record.sessionBindings = server.bus.store.all('SELECT e.member_id,e.context,b.session_key,b.session FROM endpoint_session_bindings b JOIN endpoints e ON e.id=b.endpoint_id WHERE e.group_id=? ORDER BY e.member_id,b.session_key', group.id);
  for (const host of ['codex', 'dsh', 'claude']) assert(record.hostMessages.some(row => row.host === host && row.count > 0), `${host} 缺少真实发送消息证据`);
  return record;
}

function assertPolicies(record, expectations) {
  const modes = record.policies.map(policy => [policy.host, policy.requested.mode]);
  for (const [host, mode] of Object.entries(expectations)) {
    assert(modes.some(([observedHost, observedMode]) => observedHost === host && observedMode === mode), `${host} 未出现预期 ${mode} 策略`);
  }
}

const sharedRules = '需要等待必要汇报时直接结束本回合，不要调用子 Agent、wait 或任何原生协同工具；汇报会自动回到你的同一调度会话。不要向成员发礼貌性收束消息。不要只是向用户描述计划；实际推进工作。';

try {
  server = await startServer({ directory });
  result.panelUrl = server.url;
  server.bus.on('notice', m => { console.error(m.text); });

  const discussion = await team('纯讨论验收', '目标：给出停止团队讨论的两条判断依据，并由独立成员检查是否可操作。所有工作只通过团队消息完成，不读写项目文件。', 'communication');
  await finish(discussion.group, discussion.record,
    '请组织本次讨论：让执行者给出两条停止团队讨论的判断依据（群消息形式），审查者独立检查依据是否可操作并提出意见；如需修改让执行者完善。' + sharedRules,
    'ACCEPTANCE_DONE:');
  assertPolicies(discussion.record, { codex: 'communication', dsh: 'communication', claude: 'communication' });
  console.log('DISCUSSION_OK');

  const implementation = await team('实现审查验收', '目标：实现 normalizeNames（trim、移除空字符串、大小写不敏感去重且保留首个拼写），由独立成员审查实际文件并验证示例。只允许修改本项目内 normalize-names.mjs 及必要测试文件，禁止 Git 提交与部署。');
  writeFileSync(join(workspace, 'normalize-names.mjs'), 'export const normalizeNames = names => names.map(x => x.trim()).filter(Boolean);\n');
  await finish(implementation.group, implementation.record,
    '执行团队说明中的目标。项目中已有 normalize-names.mjs 初稿，尚未按大小写不敏感去重：让执行者先读取并汇报初稿，审查者读取实际文件独立指出缺陷；随后执行者完善实现并验证示例，审查者复查最终文件。分工、修改要求与验收标准由你在群消息里说明清楚。' + sharedRules,
    'ACCEPTANCE_DONE:');
  const module = await import(`file://${join(workspace, 'normalize-names.mjs')}?t=${Date.now()}`);
  assert.deepEqual(module.normalizeNames([' A ', 'a', '', 'B', ' b ']), ['A', 'B']);
  implementation.record.artifact = readFileSync(join(workspace, 'normalize-names.mjs'), 'utf8');
  assertPolicies(implementation.record, { codex: 'communication', dsh: 'workspace-write', claude: 'workspace-write' });
  console.log('IMPLEMENTATION_OK');

  const blocked = await team('必要材料缺失验收', '目标：依据用户签字验收材料作出验收结论。材料是否齐备由团队向用户核实，不得虚构材料。', 'communication');
  await finish(blocked.group, blocked.record,
    '本目标需要的用户签字验收材料并未提供。请让执行者核实缺失项、审查者复核确实无法继续，然后把回合最终文本写成以 ACCEPTANCE_BLOCKED: 开头的说明，列出缺失材料与已尝试的核实，等待用户决定。不得虚构材料或宣布完成。' + '不要调用子 Agent、wait 或任何原生协同工具。',
    'ACCEPTANCE_BLOCKED:');
  assert(!blocked.record.messages.some(m => m.text.includes('ACCEPTANCE_DONE:')), '材料缺失不得报告完成');
  const archived = await server.bus.archiveGroup(blocked.group.id);
  assert.equal(archived.state, 'archived');
  assert.equal(server.bus.collaboration.communicationOpen(blocked.group.id), false);
  console.log('BLOCKED_OK');

  result.passed = true;
} catch (e) { result.error = e.stack; result.passed = false; process.exitCode = 1; }
finally {
  if (server) await server.close();
  result.finished = new Date().toISOString(); persist();
  console.log(JSON.stringify({ directory, passed: result.passed, error: result.error }));
}
