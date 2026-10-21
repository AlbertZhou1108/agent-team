// Real-host acceptance for session-model inheritance and agent-planned role models.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { SMART_COST_RULES } from '../src/model-policy.mjs';

const directory = mkdtempSync(resolve('work/role-model-acceptance-'));
const workspace = join(directory, 'project');
mkdirSync(workspace);
const result = { directory, workspace, started: new Date().toISOString() };
let server;

async function until(predicate, timeout = 420000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('真实验收超时');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function persist() {
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2));
}

const contract = {
  goal: '工程角色创建 answer.txt，内容严格为 MODEL_ROLE_ACCEPTANCE_OK，并由独立审查角色检查实际文件',
  scope: '仅限本次隔离验收项目',
  boundary: '禁止部署、提交 Git、外部发送或访问其他项目',
  confirmation: '目标、范围或授权变化必须由用户确认',
  delivery: '文件、执行汇报、独立审查、接受记录和完成状态',
  criteria: ['answer.txt 存在、内容严格匹配，且独立审查者检查过实际文件'],
  policy: 'workspace-write',
  allowShell: false,
};

try {
  server = await startServer({ directory });
  result.panelUrl = server.url;
  let preparation = server.bus.prepareGroup({
    name: '角色模型真实验收',
    workspace,
    lead: { name: '主 Agent', host: 'codex' },
    members: [
      { name: '工程', host: 'dsh' },
      { name: '审查', host: 'claude' },
    ],
    modelMode: 'smart',
    modelRules: SMART_COST_RULES,
  });
  result.preparation = preparation.id;
  await server.bus.preparationTurn(preparation.id, [
    '这是建群准备，不是执行任务。请严格按当前智能模型策略完成普通角色模型计划：',
    '1. 调用 model_catalog 读取实时模型目录；',
    '2. 根据成本优先规则为“工程”和“审查”逐角色选择模型与思考强度；',
    '3. 调用 team_plan_update 提交完整计划，revision 使用当前准备记录 revision；',
    `4. 随后调用 contract_propose 提交以下契约，revision 使用当前准备记录 revision：${JSON.stringify(contract)}；`,
    '5. 不要执行项目任务。',
    '工程负责文件实现；审查负责独立读取实际文件和质量把关。只能选择目录中真实存在的模型与强度。',
  ].join('\n'));
  preparation = server.bus.collaboration.preparation(preparation.id);
  if (!preparation.rolePlan) {
    await server.bus.preparationTurn(preparation.id, '你尚未提交 team_plan_update。现在必须调用 model_catalog，然后调用 team_plan_update 为工程和审查提交完整模型计划，revision 使用当前 rev。');
    preparation = server.bus.collaboration.preparation(preparation.id);
  }
  assert(preparation.sessionModel, '准备会话没有捕获自身模型');
  assert(preparation.rolePlan?.roles?.length === 2, '普通角色模型计划不完整');
  result.preparationSessionModel = preparation.sessionModel;
  result.rolePlan = preparation.rolePlan;
  if (!preparation.contract) preparation = server.bus.collaboration.propose(preparation.id, contract, preparation.revision);
  const group = server.bus.confirmPreparation(preparation.id, preparation.revision, preparation.hash);
  result.group = group.id;
  result.approvedRevision = preparation.revision;
  result.approvedHash = preparation.hash;
  persist();
  await until(() => server.bus.members(group.id).every(member => member.profile) && !server.bus.running.size, 240000);
  const members = server.bus.members(group.id);
  result.members = members.map(({ id, name, host, role, model_provider, model, reasoning_effort }) => ({ id, name, host, role, model_provider, model, reasoning_effort }));
  assert.equal(members.find(member => member.role === 'lead').model, preparation.sessionModel.model, '主 Agent未继承准备会话模型');
  for (const role of preparation.rolePlan.roles) {
    const member = members.find(item => item.name === role.name);
    assert.deepEqual(
      { provider: member.model_provider, model: member.model, effort: member.reasoning_effort },
      { provider: role.model_provider, model: role.model, effort: role.reasoning_effort },
      `${role.name}持久化模型与计划不一致`,
    );
  }
  server.bus.directive(group.id, [
    '执行当前契约。创建一个多人工作项，工程为 executor，审查为 reviewer，policy=workspace-write、allowShell=false、reviewRequired=true。',
    '工程必须在项目内创建 answer.txt，内容严格为 MODEL_ROLE_ACCEPTANCE_OK 加一个换行，然后用 send 汇报成果版本和证据。',
    '审查必须独立读取实际 answer.txt，检查内容是否严格匹配，再用 send 提交审查结论。',
    '主 Agent必须引用工程汇报和审查消息，接受工作项，覆盖完成条件，并调用 team_finish 交付；用 dispositions 处理剩余正式消息。',
    '只修改本次隔离项目中的 answer.txt。禁止部署、Git、外部发送和访问其他项目。等待成员时直接结束回合，不要调用原生子 Agent 或阻塞等待。',
  ].join('\n'));
  await until(() => server.bus.collaboration.state(group.id).phase === 'closed', 420000);
  const file = readFileSync(join(workspace, 'answer.txt'), 'utf8');
  assert.equal(file, 'MODEL_ROLE_ACCEPTANCE_OK\n');
  const state = server.bus.collaboration.read(group.id);
  assert.equal(state.state.outcome, 'completed');
  assert(state.items.some(item => item.state === 'accepted'));
  result.finalFile = file;
  result.state = state;
  result.messages = server.bus.store.all('SELECT id,seq,sender,recipient,kind,text FROM messages WHERE group_id=? ORDER BY seq', group.id);
  result.modelSelections = server.bus.store.all(`
    SELECT m.name,h.seq,h.event
    FROM history h JOIN endpoints e ON e.id=h.endpoint_id JOIN members m ON m.id=e.member_id
    WHERE e.group_id=? AND h.event LIKE '%framework.model_selection%' ORDER BY h.seq
  `, group.id).map(row => ({ member: row.name, seq: row.seq, event: JSON.parse(row.event) }));
  result.modelObservations = server.bus.store.all(`
    SELECT m.name,h.seq,h.event
    FROM history h JOIN endpoints e ON e.id=h.endpoint_id JOIN members m ON m.id=e.member_id
    WHERE e.group_id=? AND h.event LIKE '%framework.model%' AND h.event NOT LIKE '%model_selection%' ORDER BY h.seq
  `, group.id).map(row => ({ member: row.name, seq: row.seq, event: JSON.parse(row.event) }));
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  result.passed = false;
  process.exitCode = 1;
} finally {
  if (server) await server.close();
  result.finished = new Date().toISOString();
  persist();
  console.log(JSON.stringify({ directory, passed: result.passed, error: result.error }));
}
