import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { createTestGroup, fakeHost, serverScenario } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';
import * as messagesAgg from '../../aggregates/messages.mjs';
import * as conversationsAgg from '../../aggregates/conversations.mjs';
import { modelCatalog } from '../../hosts/catalog.mjs';
import { ROUTING_CAPABILITY_IDS, buildCapabilityCard, capabilityRequirementError, capabilityRow, dispatchRequirements, evaluateDispatchRequirements, executionCapabilityMap, hasDispatchRequirements, mediaCapabilityRequirements, memberPolicyCeiling, memberPolicyRequest, messageRequirements, normalizeRequiredCapabilities, policyRank, projectModelCapabilities, resolveCatalogModel, teamCapabilityView } from '../../hosts/capability-routing.mjs';
import { startServer } from '../../server.mjs';
import { validatePanelTool } from '../../tools/panel.mjs';
import { createCodexHost, CODEX_TRAITS } from '../../member/codex/index.mjs';
import { memberExecutionCapabilities, browserToolCapability } from '../../hosts/execution.mjs';
import { createClaudeHost, CLAUDE_TRAITS } from '../../member/claude/index.mjs';
import { createDshHost, DSH_TRAITS } from '../../member/dsh/index.mjs';
import { createZcodeHost, ZCODE_TRAITS } from '../../member/zcode/index.mjs';
import { execFileSync } from 'node:child_process';
import { validateTool } from '../../tools/registry.mjs';

describe('capability-dispatch', () => {
const VISION = {
  key: 'vision', id: 'vision', label: 'Vision', provider: 'fake-provider',
  inputModalities: ['text', 'image'], contextWindow: 200000,
  reasoningEfforts: [{ id: 'low', label: 'Low' }], defaultReasoningEffort: 'low',
  isDefault: true,
};
const TEXT_ONLY = {
  key: 'text-only', id: 'text-only', label: 'Text Only', provider: 'fake-provider',
  inputModalities: ['text'], contextWindow: 32000,
  reasoningEfforts: [{ id: 'low', label: 'Low' }], defaultReasoningEffort: 'low',
};

function capabilityFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-capability-'));
  const calls = [];
  const host = fakeHost({
    calls,
    run: async context => {
      context.onAccepted();
      return 'host final';
    },
  });
  host.listModels = async () => ({
    version: 1,
    host: 'fake',
    source: 'test',
    defaultModel: VISION.key,
    reasoningEfforts: [],
    models: [VISION, TEXT_ONLY],
  });
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => {
    if (!bus.closing) await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论 */ }
  });
  return { bus, directory, calls, host };
}

async function readOnlyGroup(bus, directory) {
  const group = createTestGroup(bus, {
    name: '能力团队',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
    policy: 'read-only',
  });
  await until(() => bus.running.size === 0);
  return group;
}

function memberOf(bus, group, name) {
  return bus.members(group.id).find(member => member.name === name);
}

function promptJson(call) {
  return call.prompt.startsWith('{') ? JSON.parse(call.prompt) : null;
}

test('members returns read-only capability cards and only coordination turns get the compact team view', async t => {
  const { bus, directory, calls } = capabilityFixture(t);
  const group = await readOnlyGroup(bus, directory);
  await bus.modelCatalog({ host: 'fake' });
  const lead = memberOf(bus, group, 'lead');
  const worker = memberOf(bus, group, 'worker');
  const leadEndpoint = bus.store.endpoint(lead.id, 'coordination');

  const rows = await bus.tool(leadEndpoint.id, leadEndpoint.key, 'members', {});
  assert.equal(rows.length, 2);
  const workerRow = rows.find(row => row.id === worker.id);
  assert.deepEqual(
    Object.keys(workerRow).sort(),
    ['capabilityCard', 'host', 'id', 'name', 'profile', 'role'].sort(),
  );
  const card = workerRow.capabilityCard;
  assert.equal(card.model.knownInCatalog, true);
  assert.equal(card.model.id, 'vision');
  assert.deepEqual(card.model.inputModalities, ['text', 'image']);
  assert.equal(card.model.contextWindow, 200000);
  assert.equal(card.modelSummary.host, 'fake');
  assert.equal(card.effectiveCapabilities['modal.image'], true);
  assert.equal(card.effectiveCapabilities['exec.read'], true);
  assert.equal(card.effectiveCapabilities['exec.write'], false);
  assert.equal(card.effectiveCapabilities['tool.browser'], false);
  assert.equal(card.effectivePolicy.ceiling, 'read-only');
  assert.equal(card.effectivePolicy.mode, 'read-only');

  // 成员向主控汇报 → 主控协调回合的输入带精简能力视图。
  const workerEndpoint = bus.store.endpoint(worker.id, `pair:${lead.id}`, lead.id);
  await bus.tool(workerEndpoint.id, workerEndpoint.key, 'send', { to: lead.id, text: '已完成自检' });
  await until(() => calls.some(call => call.endpoint.id === leadEndpoint.id && call.endpoint.context === 'coordination'));
  await until(() => bus.running.size === 0);
  const coordinationCall = calls.find(call => call.endpoint.id === leadEndpoint.id && call.endpoint.context === 'coordination');
  const coordinationInput = promptJson(coordinationCall);
  assert.ok(coordinationInput?.teamCapabilities);
  assert.equal(coordinationInput.teamCapabilities.controller.kind, 'member');
  assert.equal(coordinationInput.teamCapabilities.controller.model, 'vision');
  assert.equal(coordinationInput.teamCapabilities.members.length, 2);
  const workerLine = coordinationInput.teamCapabilities.members.find(row => row.id === worker.id);
  assert.deepEqual(
    Object.keys(workerLine).sort(),
    ['contextWindow', 'execRead', 'execShell', 'execWrite', 'id', 'knownInCatalog', 'modalImage', 'model', 'name', 'provider', 'role', 'toolBrowser'].sort(),
  );
  assert.equal(workerLine.modalImage, true);
  assert.equal(workerLine.execRead, true);
  assert.equal(workerLine.execWrite, false);
  assert.equal(workerLine.toolBrowser, false);

  // 普通 pair 回合不注入团队能力视图,保持本地输入的原有形状。
  await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', { to: worker.id, text: '继续下一步' });
  await until(() => calls.some(call => call.endpoint.id === workerEndpoint.id));
  await until(() => bus.running.size === 0);
  const pairCall = calls.find(call => call.endpoint.id === workerEndpoint.id && call.endpoint.context === `pair:${lead.id}`);
  const pairInput = promptJson(pairCall);
  assert.ok(pairInput);
  assert.equal(pairInput.teamCapabilities, undefined);
  // 入群自述回合同样不带能力视图。
  for (const call of calls.filter(item => item.endpoint.context === 'profile')) {
    const profileInput = promptJson(call);
    if (profileInput) assert.equal(profileInput.teamCapabilities, undefined);
  }
});

test('member dispatch gate rejects before writing, normalizes legacy aliases and leaves unconstrained sends alone', async t => {
  const { bus, directory } = capabilityFixture(t);
  const group = await readOnlyGroup(bus, directory);
  await bus.modelCatalog({ host: 'fake' });
  const lead = memberOf(bus, group, 'lead');
  const worker = memberOf(bus, group, 'worker');
  const leadEndpoint = bus.store.endpoint(lead.id, 'coordination');
  const baseline = {
    messages: bus.store.all('SELECT id FROM messages').length,
    outbox: bus.store.all('SELECT id FROM outbox').length,
  };

  let capabilityError;
  await assert.rejects(
    async () => {
      try {
        await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
          to: worker.id,
          text: '请修改项目文件。',
          requiredCapabilities: ['file.write', 'filesystem.boundary'],
        });
      } catch (error) {
        capabilityError = error;
        throw error;
      }
    },
    /capability_required/,
  );
  assert.equal(capabilityError.code, 'capability_required');
  assert.deepEqual(capabilityError.details.missingCapabilities, ['exec.write']);
  assert.equal(capabilityError.details.member, 'worker');

  let contextError;
  await assert.rejects(
    async () => {
      try {
        await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
          to: worker.id,
          text: '请带上完整代码。',
          minContextWindow: 300000,
        });
      } catch (error) {
        contextError = error;
        throw error;
      }
    },
    /capability_required/,
  );
  assert.deepEqual(contextError.details.missingCapabilities, ['minContextWindow']);

  await assert.rejects(
    async () => {
      await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
        to: worker.id,
        text: '请处理视频。',
        requiredCapabilities: ['modal.video'],
      });
    },
    /必须是以下值之一/,
  );
  const afterRejects = {
    messages: bus.store.all('SELECT id FROM messages').length,
    outbox: bus.store.all('SELECT id FROM outbox').length,
  };
  assert.deepEqual(afterRejects, baseline);

  // 旧 file.* 别名归一化后落库 canonical ID。
  const allowed = await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
    to: worker.id,
    text: '请阅读项目说明。',
    requiredCapabilities: ['file.read'],
  });
  const allowedRow = messagesAgg.byId(bus.store, allowed.messageId);
  assert.deepEqual(JSON.parse(allowedRow.required_capabilities), ['exec.read']);
  assert.equal(allowedRow.min_context_window, null);

  // 未声明的模型(不在实时目录里)按 'unknown' 保守拒绝,写库前不落消息。
  bus.applyMemberModel(group.id, worker.id, { model_provider: 'fake-provider', model: 'ghost', reasoning_effort: 'low' });
  const beforeUnknown = bus.store.all('SELECT id FROM messages').length;
  let imageError;
  await assert.rejects(
    async () => {
      try {
        await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
          to: worker.id,
          text: '请识别这张图片。',
          requiredCapabilities: ['modal.image'],
        });
      } catch (error) {
        imageError = error;
        throw error;
      }
    },
    /capability_required/,
  );
  assert.deepEqual(imageError.details.missingCapabilities, ['modal.image']);
  assert.match(imageError.details.reasons[0], /模型目录尚未探测|未返回/);
  const afterUnknown = bus.store.all('SELECT id FROM messages').length;
  assert.equal(afterUnknown, beforeUnknown);

  // 发给用户的消息不是派工,不检查能力也不持久化约束。
  const toUser = await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
    to: 'user',
    text: '向用户同步进度。',
    requiredCapabilities: ['tool.browser'],
  });
  const userRow = messagesAgg.byId(bus.store, toUser.messageId);
  assert.ok(userRow);
  assert.equal(userRow.recipient, 'user');
  assert.equal(userRow.required_capabilities, '[]');
  assert.equal(userRow.min_context_window, null);
  const userMessages = bus.store.all("SELECT id FROM messages WHERE recipient='user'");
  assert.equal(userMessages.length, 1);

  // 无约束的 send/note 完全不受影响。
  const plain = await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', { to: worker.id, text: '普通同步' });
  assert.ok(plain.messageId);
  const note = await bus.tool(leadEndpoint.id, leadEndpoint.key, 'note', { to: worker.id, text: '稍后查看' });
  assert.ok(note.messageId);
  await until(() => bus.running.size === 0);
});

function prepareQueued(group, bus, member, lead, text, capabilities = null) {
  const message = messagesAgg.append(bus.store, group.id, lead.id, member.id, 'send', text, null, false);
  if (capabilities) messagesAgg.setRequiredCapabilities(bus.store, message.id, capabilities);
  // 真实调度路径从 pending() 读的是数据库最新行,这里同样重新读一次再入队。
  const fresh = messagesAgg.byId(bus.store, message.id);
  const conversation = conversationsAgg.forMember(bus.store, member.id, `pair:${lead.id}`, { peer: lead.id });
  const entry = messagesAgg.prepareDelivery(bus.store, conversation, fresh);
  return { message: fresh, entry };
}

test('pre-dispatch recheck blocks the whole batch without starting a host turn', async t => {
  const { bus, directory, calls } = capabilityFixture(t);
  const group = await readOnlyGroup(bus, directory);
  await bus.modelCatalog({ host: 'fake' });
  const lead = memberOf(bus, group, 'lead');
  const worker = memberOf(bus, group, 'worker');
  bus.applyMemberModel(group.id, worker.id, { model_provider: 'fake-provider', model: 'vision', reasoning_effort: 'low' });
  const { message, entry } = prepareQueued(group, bus, worker, lead, '把图片里的表格整理成 markdown', ['modal.image']);
  // 排队后、投递前换回纯文本模型:执行前复核必须用最新选择重算。
  bus.applyMemberModel(group.id, worker.id, { model_provider: 'fake-provider', model: 'text-only', reasoning_effort: 'low' });

  const failures = [];
  const notices = [];
  bus.on('delivery-failure', event => failures.push(event));
  bus.on('notice', notice => notices.push(notice));
  const outboxBefore = bus.store.all('SELECT id FROM outbox').length;
  bus.pump();
  await until(() => Boolean(bus.store.get('SELECT error FROM outbox WHERE id=?', entry.id)?.error));
  await until(() => failures.length > 0);

  const workerConversation = conversationsAgg.forMember(bus.store, worker.id, `pair:${lead.id}`, { peer: lead.id });
  assert.equal(calls.filter(call => call.endpoint.id === workerConversation.id).length, 0);
  const entryError = bus.store.get('SELECT error FROM outbox WHERE id=?', entry.id).error;
  assert.match(entryError, /能力复核未通过/);
  const blockedRow = bus.store.all('SELECT * FROM outbox WHERE id!=? AND error IS NOT NULL', entry.id)[0];
  assert.ok(blockedRow);
  assert.match(blockedRow.error, /modal.image/);
  const blockedPayload = JSON.parse(blockedRow.payload);
  assert.equal(blockedPayload.message.id, message.id);
  const attached = bus.store.get('SELECT outbox_id FROM attached WHERE message_id=?', message.id);
  assert.equal(attached.outbox_id, blockedRow.id);
  const outboxAfter = bus.store.all('SELECT id FROM outbox');
  assert.equal(outboxAfter.length, outboxBefore + 1);
  assert.equal(failures.some(event => event.messageId === message.id && /image/.test(event.reason)), true);
  const leakedUserMessages = bus.store.all("SELECT id FROM messages WHERE recipient='user'");
  assert.equal(leakedUserMessages.length, 0);
  const notice = bus.store.all("SELECT * FROM messages WHERE kind='system' AND recipient=?", lead.id)
    .find(row => /执行前复核拦截了发往成员 worker/.test(row.text));
  assert.ok(notice);
  assert.match(notice.text, /member_model|group_add/);
  assert.equal(notices.some(item => item.id === notice.id), true);
  // 原 outbox 行必须同步关账,否则会一直占着该会话的待投递槽。
  assert.deepEqual(bus.store.pendingDeliveries(), []);
});

test('pre-dispatch recheck only blocks the unsatisfied message in a batch', async t => {
  const { bus, directory, calls } = capabilityFixture(t);
  const group = await readOnlyGroup(bus, directory);
  await bus.modelCatalog({ host: 'fake' });
  const lead = memberOf(bus, group, 'lead');
  const worker = memberOf(bus, group, 'worker');
  bus.applyMemberModel(group.id, worker.id, { model_provider: 'fake-provider', model: 'vision', reasoning_effort: 'low' });
  const conversation = conversationsAgg.forMember(bus.store, worker.id, `pair:${lead.id}`, { peer: lead.id });

  const plain = messagesAgg.append(bus.store, group.id, lead.id, worker.id, 'send', '先读一下说明', null, false);
  const image = messagesAgg.append(bus.store, group.id, lead.id, worker.id, 'send', '再看图片', null, false);
  messagesAgg.setRequiredCapabilities(bus.store, image.id, ['modal.image']);
  const entry = messagesAgg.prepareDelivery(bus.store, conversation, plain);
  const payload = JSON.parse(entry.payload);
  assert.equal(payload.additionalMessages.length, 1);
  assert.equal(payload.additionalMessages[0].id, image.id);

  bus.applyMemberModel(group.id, worker.id, { model_provider: 'fake-provider', model: 'text-only', reasoning_effort: 'low' });
  const failures = [];
  bus.on('delivery-failure', event => failures.push(event));
  bus.pump();
  await until(() => Boolean(bus.store.get('SELECT accepted FROM outbox WHERE id=?', entry.id)?.accepted));
  await until(() => bus.running.size === 0 && calls.some(call => call.endpoint.id === conversation.id));

  const memberCalls = calls.filter(call => call.endpoint.id === conversation.id);
  assert.equal(memberCalls.length, 1);
  const input = JSON.parse(memberCalls[0].prompt);
  assert.equal(input.input.message.id, plain.id);
  assert.equal(memberCalls[0].prompt.includes(image.id), false);
  assert.equal(failures.some(event => event.messageId === plain.id), false);
  assert.equal(failures.some(event => event.messageId === image.id && /image/.test(event.reason)), true);

  const original = bus.store.get('SELECT accepted,error FROM outbox WHERE id=?', entry.id);
  assert.ok(original.accepted);
  assert.equal(original.error, null);
  const blockedRow = bus.store.all('SELECT * FROM outbox WHERE id!=? AND error IS NOT NULL', entry.id)[0];
  assert.ok(blockedRow);
  assert.match(blockedRow.error, /modal.image/);
  assert.equal(JSON.parse(blockedRow.payload).message.id, image.id);
  const plainAttached = bus.store.get('SELECT outbox_id FROM attached WHERE message_id=?', plain.id);
  const imageAttached = bus.store.get('SELECT outbox_id FROM attached WHERE message_id=?', image.id);
  assert.equal(plainAttached.outbox_id, entry.id);
  assert.equal(imageAttached.outbox_id, blockedRow.id);
  assert.deepEqual(bus.store.pendingDeliveries(), []);
});
});

describe('capability-routing', () => {
function catalogOf(models, extra = {}) {
  return modelCatalog({
    host: 'fake',
    source: 'test',
    models,
    defaultModel: extra.defaultModel ?? models[0]?.id ?? null,
    reasoningEfforts: [],
    ...extra,
  });
}

const VISION = { id: 'vision', key: 'vision', label: 'Vision', provider: 'p', inputModalities: ['text', 'image'], contextWindow: 200000, reasoningEfforts: [{ id: 'low', label: 'low' }] };
const TEXT_ONLY = { id: 'text-only', key: 'text-only', label: 'Text', provider: 'p', inputModalities: ['text'], contextWindow: 32000 };
const UNDECLARED = { id: 'opaque', key: 'opaque', label: 'Opaque', provider: 'p' };

test('model projection keeps undeclared facts undeclared instead of guessing', () => {
  const catalog = catalogOf([VISION, TEXT_ONLY, UNDECLARED]);
  const vision = projectModelCapabilities({ catalog, selection: { model: 'vision', model_provider: 'p' } });
  assert.equal(vision.model.knownInCatalog, true);
  assert.equal(vision.modalImage, true);
  assert.equal(vision.model.contextWindow, 200000);
  assert.deepEqual(vision.model.inputModalities, ['text', 'image']);

  const textOnly = projectModelCapabilities({ catalog, selection: { model: 'text-only' } });
  assert.equal(textOnly.modalImage, false);
  assert.equal(textOnly.model.contextWindow, 32000);

  // 目录返回记录但未声明模态/窗口：能力不明而非不支持的结论。
  const opaque = projectModelCapabilities({ catalog, selection: { model: 'opaque' } });
  assert.equal(opaque.model.knownInCatalog, true);
  assert.equal(opaque.modalImage, 'unknown');
  assert.equal(opaque.model.inputModalities, null);
  assert.equal(opaque.model.contextWindow, null);

  // 目录里没有该模型（例如宿主默认模型未知）：同样保持 unknown。
  const missing = projectModelCapabilities({ catalog, selection: { model: 'not-listed' } });
  assert.equal(missing.model.knownInCatalog, false);
  assert.equal(missing.modalImage, 'unknown');
  assert.equal(missing.model.contextWindow, null);
  assert.equal(missing.modelSummary.host, 'fake');
});

test('model selection is only matched against real catalog records', () => {
  const catalog = catalogOf([VISION, TEXT_ONLY]);

  // provider 不匹配视为目录里没有该配置，不跨 provider 借用同名能力。
  assert.equal(resolveCatalogModel(catalog, { model: 'vision', model_provider: 'other' }), null);
  assert.equal(resolveCatalogModel(catalog, { model: 'vision', model_provider: 'p' }).id, 'vision');

  // 没有显式选择时按宿主默认模型、isDefault、首个记录依次回退。
  assert.equal(resolveCatalogModel(catalog, null).id, 'vision');
  const byDefault = catalogOf([TEXT_ONLY, { ...VISION, isDefault: true }], { defaultModel: 'text-only' });
  assert.equal(resolveCatalogModel(byDefault, null).id, 'text-only');
  const byFlag = catalogOf([TEXT_ONLY, { ...VISION, isDefault: true }], { defaultModel: null });
  assert.equal(resolveCatalogModel(byFlag, null).id, 'vision');
  assert.equal(resolveCatalogModel(null, null), null);
  assert.equal(resolveCatalogModel({ models: [] }, null), null);
});

test('reasoning effort comes from the live selection and catalog entry', () => {
  const catalog = catalogOf([{ ...VISION, defaultReasoningEffort: 'low' }]);
  const explicit = projectModelCapabilities({ catalog, selection: { model: 'vision', reasoning_effort: 'high' } });
  assert.equal(explicit.model.reasoningEffort, 'high');
  assert.deepEqual(explicit.model.reasoningEfforts, ['low']);
  const fallback = projectModelCapabilities({ catalog, selection: { model: 'vision' } });
  assert.equal(fallback.model.reasoningEffort, 'low');
  assert.deepEqual(projectModelCapabilities({ catalog, selection: { model: 'opaque' } }).model.reasoningEfforts, []);
});

test('required capabilities normalize legacy aliases, dedupe and keep unknown ids aside', () => {
  const { required, unknown } = normalizeRequiredCapabilities(['file.write', 'filesystem.boundary', 'shell.exec', 'exec.read', 'file.read', 'modal.video']);
  assert.deepEqual(required, ['exec.write', 'exec.shell', 'exec.read']);
  assert.deepEqual(unknown, ['modal.video']);
  assert.deepEqual(normalizeRequiredCapabilities(['  ']).required, []);
  assert.deepEqual(normalizeRequiredCapabilities(null).required, []);
  assert.equal(ROUTING_CAPABILITY_IDS.includes('modal.video'), false);
});

test('dispatch requirements only combine explicit fields and structured media facts', () => {
  const merged = dispatchRequirements({ requiredCapabilities: ['file.write'], minContextWindow: 100000, mediaTypes: ['image/png', 'text/plain'] });
  assert.deepEqual(merged.requiredCapabilities, ['exec.write', 'modal.image']);
  assert.equal(merged.minContextWindow, 100000);
  // 正文/文件名不参与；只有 mediaType 是结构化事实。
  assert.deepEqual(mediaCapabilityRequirements(['application/pdf']), []);
  assert.deepEqual(mediaCapabilityRequirements(['image/jpeg']), ['modal.image']);
  assert.deepEqual(mediaCapabilityRequirements(undefined), []);

  // 非正整数门槛一律不生效，避免把 0 或字符串误当约束。
  for (const value of [0, -1, 1.5, '1000', null, undefined]) {
    assert.equal(dispatchRequirements({ minContextWindow: value }).minContextWindow, null);
  }
  assert.equal(hasDispatchRequirements(dispatchRequirements({ requiredCapabilities: ['file.read'] })), true);
  assert.equal(hasDispatchRequirements(dispatchRequirements({ minContextWindow: 64000 })), true);
  assert.equal(hasDispatchRequirements(dispatchRequirements({})), false);
});

function cardFor({ catalog, selection = null, policy = null }) {
  return buildCapabilityCard({
    member: { id: 'm1', host: 'fake' },
    selection,
    catalog,
    policy,
  });
}

test('capability card projects both dimensions and never invents browser access', () => {
  const catalog = catalogOf([VISION]);
  const card = cardFor({
    catalog,
    selection: { model: 'vision' },
    policy: { requested: 'read-only', effective: 'read-only', capabilities: ['exec.read'], reason: '群策略只允许读取' },
  });
  assert.equal(card.memberId, 'm1');
  assert.equal(card.model.id, 'vision');
  assert.equal(card.model.knownInCatalog, true);
  assert.deepEqual(card.effectivePolicy, { ceiling: 'read-only', mode: 'read-only', reason: '群策略只允许读取', browserReason: null });
  assert.deepEqual(card.effectiveCapabilities, {
    'exec.read': true,
    'exec.write': false,
    'exec.shell': false,
    'modal.image': true,
    'tool.browser': false,
  });
  assert.equal(Object.hasOwn(card, 'controller'), false);

  // 没有目录记录（例如外部主控绑定的声明的能力）时，模型维保守保持 unknown。
  const withController = buildCapabilityCard({
    member: { id: 'm1', host: 'fake' },
    catalog: null,
    policy: null,
    controller: { kind: 'external_agent', bindingId: 'b1' },
  });
  assert.deepEqual(withController.controller, { kind: 'external_agent', bindingId: 'b1' });
  assert.deepEqual(withController.effectiveCapabilities, {
    'exec.read': false,
    'exec.write': false,
    'exec.shell': false,
    'modal.image': 'unknown',
    'tool.browser': false,
  });
  assert.deepEqual(executionCapabilityMap({ capabilities: ['exec.write'] }), { 'exec.read': false, 'exec.write': true, 'exec.shell': false });
  assert.deepEqual(executionCapabilityMap(null), { 'exec.read': false, 'exec.write': false, 'exec.shell': false });
});

test('dispatch evaluation fails closed on unknown facts', () => {
  const catalog = catalogOf([VISION, TEXT_ONLY, UNDECLARED]);
  const readonly = { requested: 'workspace-write', effective: 'read-only', capabilities: ['exec.read'], reason: '宿主无法保证工作区写边界' };

  const allowed = evaluateDispatchRequirements(cardFor({ catalog, selection: { model: 'vision' }, policy: readonly }), {
    requiredCapabilities: ['exec.read', 'modal.image'],
    minContextWindow: 200000,
  });
  assert.deepEqual(allowed, { ok: true, missingCapabilities: [], reasons: [] });

  const unknownImage = evaluateDispatchRequirements(cardFor({ catalog, selection: { model: 'opaque' }, policy: readonly }), {
    requiredCapabilities: ['modal.image'],
  });
  assert.equal(unknownImage.ok, false);
  assert.deepEqual(unknownImage.missingCapabilities, ['modal.image']);
  assert.match(unknownImage.reasons[0], /未声明输入模态|尚未探测/);

  const textOnlyImage = evaluateDispatchRequirements(cardFor({ catalog, selection: { model: 'text-only' }, policy: readonly }), {
    requiredCapabilities: ['modal.image'],
  });
  assert.deepEqual(textOnlyImage.missingCapabilities, ['modal.image']);
  assert.match(textOnlyImage.reasons[0], /仅声明支持 text/);

  const execGap = evaluateDispatchRequirements(cardFor({ catalog, selection: { model: 'vision' }, policy: readonly }), {
    requiredCapabilities: ['exec.write', 'exec.shell', 'tool.browser'],
  });
  assert.deepEqual(execGap.missingCapabilities, ['exec.write', 'exec.shell', 'tool.browser']);
  assert.match(execGap.reasons[0], /群策略上限为 workspace-write/);
  assert.match(execGap.reasons[2], /浏览器|Computer Use/);

  const windowGap = evaluateDispatchRequirements(cardFor({ catalog, selection: { model: 'text-only' }, policy: readonly }), {
    minContextWindow: 128000,
  });
  assert.deepEqual(windowGap.missingCapabilities, ['minContextWindow']);
  assert.match(windowGap.reasons[0], /32000/);

  const windowUnknown = evaluateDispatchRequirements(cardFor({ catalog, selection: { model: 'opaque' }, policy: readonly }), {
    minContextWindow: 128000,
  });
  assert.deepEqual(windowUnknown.missingCapabilities, ['minContextWindow']);
  assert.match(windowUnknown.reasons[0], /未知/);

  // 无要求的派工永远放行，不做任何隐式能力推断。
  assert.deepEqual(evaluateDispatchRequirements(cardFor({ catalog, selection: { model: 'opaque' }, policy: null }), {}), { ok: true, missingCapabilities: [], reasons: [] });
});

test('gate error exposes the shared code and missing capability details', () => {
  const catalog = catalogOf([TEXT_ONLY]);
  const card = cardFor({ catalog, selection: { model: 'text-only' }, policy: { requested: 'read-only', effective: 'read-only', capabilities: ['exec.read'] } });
  const evaluation = evaluateDispatchRequirements(card, { requiredCapabilities: ['modal.image'] });
  const error = capabilityRequirementError('成员甲', evaluation, { executionPolicy: { effective: 'read-only' } });
  assert.equal(error.code, 'capability_required');
  assert.equal(error.details.member, '成员甲');
  assert.deepEqual(error.details.missingCapabilities, ['modal.image']);
  assert.deepEqual(error.details.executionPolicy, { effective: 'read-only' });
  assert.match(error.message, /capability_required: 成员 成员甲 缺少 modal.image/);
});

test('persisted message requirements treat legacy rows as unconstrained', () => {
  assert.deepEqual(messageRequirements({ required_capabilities: '[]', min_context_window: null }), { requiredCapabilities: [], minContextWindow: null });
  assert.deepEqual(messageRequirements({ required_capabilities: '["file.write"]', min_context_window: 64000 }), { requiredCapabilities: ['exec.write'], minContextWindow: 64000 });
  // 旧消息没有该列/值非法时按无约束处理，不误拦历史数据。
  assert.deepEqual(messageRequirements({}), { requiredCapabilities: [], minContextWindow: null });
  assert.deepEqual(messageRequirements({ required_capabilities: 'not-json', min_context_window: 0 }), { requiredCapabilities: [], minContextWindow: null });
});

test('compact capability rows feed team context without leaking the full card', () => {
  const catalog = catalogOf([VISION]);
  const card = cardFor({
    catalog,
    selection: { model: 'vision' },
    policy: { requested: 'workspace-write', effective: 'workspace-write', capabilities: ['exec.read', 'exec.write'] },
  });
  assert.deepEqual(capabilityRow(card, { id: 'm1', name: '成员甲', role: 'member' }), {
    id: 'm1',
    name: '成员甲',
    role: 'member',
    model: 'vision',
    provider: 'p',
    knownInCatalog: true,
    modalImage: true,
    contextWindow: 200000,
    execRead: true,
    execWrite: true,
    execShell: false,
    toolBrowser: false,
  });
  const view = teamCapabilityView({
    controller: { id: 'lead', name: '主控', kind: 'member' },
    controllerCard: card,
    members: [{ id: 'm1', role: 'member', capabilityCard: card }],
  });
  assert.equal(view.controller.kind, 'member');
  assert.equal(view.members.length, 1);
  assert.equal(view.members[0].execWrite, true);
  assert.equal(Object.hasOwn(view.members[0], 'effectivePolicy'), false);
});

test('member policy never exceeds the group ceiling and intersects shell/browser flags', () => {
  const group = { policy: 'workspace-write', allow_shell: 1 };
  assert.equal(policyRank('communication'), 0);
  assert.equal(policyRank('full-access') > policyRank('workspace-write'), true);
  assert.deepEqual(memberPolicyRequest(group, {}), { ceiling: 'workspace-write', allowShell: true, allowBrowser: false });

  // 成员只能向下收敛：更严格的上限生效，更宽松的上限被群策略钳住。
  assert.equal(memberPolicyCeiling(group, { policy_ceiling: 'read-only' }), 'read-only');
  assert.equal(memberPolicyCeiling(group, { policy_ceiling: 'full-access' }), 'workspace-write');
  assert.equal(memberPolicyCeiling({ policy: 'read-only' }, { policy_ceiling: 'workspace-write' }), 'read-only');
  assert.equal(memberPolicyCeiling(group, { policy_ceiling: null }), 'workspace-write');

  // 命令与浏览器开关同样取交集：成员显式关闭优先，通信上限下浏览器恒关闭。
  assert.deepEqual(memberPolicyRequest(group, { policy_ceiling: 'read-only', allow_shell: 0, allow_browser: 1 }), {
    ceiling: 'read-only', allowShell: false, allowBrowser: true,
  });
  assert.deepEqual(memberPolicyRequest(group, { policy_ceiling: 'communication', allow_browser: 1 }), {
    ceiling: 'communication', allowShell: true, allowBrowser: false,
  });
  assert.deepEqual(memberPolicyRequest({ policy: 'workspace-write', allow_shell: 0 }, { allow_shell: 1 }), {
    ceiling: 'workspace-write', allowShell: false, allowBrowser: false,
  });
  assert.equal(memberPolicyRequest(group, { allow_shell: null }).allowShell, true);
  assert.equal(memberPolicyRequest(group, { allow_shell: 0 }).allowShell, false);
});

test('browser capability is only claimed from an explicit host toolBrowser report', () => {
  const catalog = catalogOf([VISION]);
  const projection = { requested: 'workspace-write', effective: 'workspace-write', capabilities: ['exec.read', 'exec.write'] };
  const unauthorized = cardFor({ catalog, selection: { model: 'vision' }, policy: { ...projection, allowBrowser: false, browserReason: '成员未获浏览器授权' } });
  assert.equal(unauthorized.effectiveCapabilities['tool.browser'], false);
  assert.equal(unauthorized.effectivePolicy.browserReason, '成员未获浏览器授权');

  const reported = cardFor({ catalog, selection: { model: 'vision' }, policy: { ...projection, allowBrowser: true, toolBrowser: true } });
  assert.equal(reported.effectiveCapabilities['tool.browser'], true);

  // 通信策略下即使宿主报告可用也强制关闭。
  const communication = cardFor({ catalog, selection: { model: 'vision' }, policy: { requested: 'communication', effective: 'communication', capabilities: [], toolBrowser: true } });
  assert.equal(communication.effectiveCapabilities['tool.browser'], false);
  assert.equal(communication.effectivePolicy.browserReason, null);
});
});

describe('member-policy', () => {
const CODER = {
  key: 'coder', id: 'coder', label: 'Coder', provider: 'prov-a',
  inputModalities: ['text'], contextWindow: 128000,
  reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
  defaultReasoningEffort: 'low', isDefault: true,
};

function makeHost() {
  return {
    async listModels() {
      return { version: 1, host: 'codex', source: 'test', defaultModel: 'coder', reasoningEfforts: [], models: [CODER] };
    },
    // 真实 Codex 适配器为同步执行能力报告：授权且有原生浏览器工具时 toolBrowser 才为 true。
    executionCapabilities({ mode, allowShell, allowBrowser }) {
      if (mode === 'communication') return { effectivePolicy: 'communication', capabilities: [], reason: '仅允许团队通信', toolBrowser: false };
      if (mode === 'read-only') {
        return { effectivePolicy: 'read-only', capabilities: ['exec.read'], reason: '群策略只允许读取', toolBrowser: allowBrowser === true, browserReason: allowBrowser === true ? null : '成员未获浏览器/Computer Use 授权（allowBrowser=false）' };
      }
      return {
        effectivePolicy: 'workspace-write',
        capabilities: ['exec.read', 'exec.write', ...(allowShell ? ['exec.shell'] : [])],
        reason: null,
        toolBrowser: allowBrowser === true,
        browserReason: allowBrowser === true ? null : '成员未获浏览器/Computer Use 授权（allowBrowser=false）',
      };
    },
    async run(context) {
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      if (context.endpoint.context === 'profile') {
        await context.onTool('profile_set', { text: 'ready' });
        context.onAccepted();
        return '';
      }
      context.onAccepted();
      return '';
    },
  };
}

async function policyFixture(t, { policy = 'workspace-write', members = ['worker'] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'member-policy-'));
  const server = await startServer({ directory, hosts: new Map([['codex', makeHost()]]) });
  t.after(async () => {
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论 */ }
  });
  const bus = server.bus;
  const group = createTestGroup(bus, {
    name: '策略团队',
    workspace: directory,
    policy,
    lead: { name: 'lead', host: 'codex' },
    members: members.map(name => ({ name, host: 'codex' })),
  });
  await until(() => bus.running.size === 0);
  const lead = bus.members(group.id).find(member => member.role === 'lead');
  const worker = bus.members(group.id).find(member => member.role === 'member');
  return { server, bus, url: server.url, directory, group, lead, worker };
}

function bindSession(bus, conversation, session) {
  bus.store.run('UPDATE conversations SET session=? WHERE id=?', session, conversation.id);
  bus.store.run(
    'INSERT INTO conversation_session_meta(conversation_id,session_key,session) VALUES(?,?,?)',
    conversation.id, 'manual-key', session,
  );
}

function postPolicy(url, groupId, memberId, body, init = {}) {
  return fetch(new URL(`/api/teams/${groupId}/members/${memberId}/policy`, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

test('policy HTTP route applies the policy, clears old sessions and rejects invalid changes', async t => {
  const f = await policyFixture(t);
  const conversation = f.bus.store.endpoint(f.worker.id, 'coordination');
  bindSession(f.bus, conversation, 'manual-session-1');

  const response = await postPolicy(f.url, f.group.id, f.worker.id, {
    policyCeiling: 'read-only',
    allowShell: false,
    allowBrowser: false,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.member.policy_ceiling, 'read-only');
  assert.equal(body.member.allow_shell, 0);
  assert.equal(body.member.allow_browser, 0);
  assert.equal(body.member.capabilityCard.effectivePolicy.ceiling, 'read-only');
  assert.equal(body.member.capabilityCard.effectiveCapabilities['exec.write'], false);

  // 旧宿主会话绑定被清理；随后若被通知唤醒也会以新会话启动，不会沿用旧值。
  const cleared = f.bus.store.get('SELECT session FROM conversations WHERE id=?', conversation.id);
  assert.notEqual(cleared.session, 'manual-session-1');
  const metaRows = f.bus.store.all('SELECT * FROM conversation_session_meta WHERE conversation_id=? AND session=?', conversation.id, 'manual-session-1');
  assert.equal(metaRows.length, 0);
  const notices = f.bus.store.all("SELECT text FROM messages WHERE group_id=? AND recipient=? AND sender='system'", f.group.id, f.worker.id);
  assert.ok(notices.some(row => /执行能力已更新为 read-only/.test(row.text)));

  // 仅换模型不清会话（既有 member_model 差异保持）。
  const pairConversation = f.bus.store.endpoint(f.worker.id, `pair:${f.lead.id}`, f.lead.id);
  bindSession(f.bus, pairConversation, 'manual-session-keep');
  f.bus.applyMemberModel(f.group.id, f.worker.id, { model_provider: 'prov-a', model: 'coder', reasoning_effort: 'low' });
  const keptConversation = f.bus.store.get('SELECT session FROM conversations WHERE id=?', pairConversation.id);
  const keptMeta = f.bus.store.all('SELECT * FROM conversation_session_meta WHERE conversation_id=?', pairConversation.id);
  assert.equal(keptConversation.session, 'manual-session-keep');
  assert.equal(keptMeta.length, 1);

  // Content-Type 与未知字段校验。
  const noJson = await fetch(new URL(`/api/teams/${f.group.id}/members/${f.worker.id}/policy`, f.url), {
    method: 'POST', body: JSON.stringify({ allowBrowser: true }),
  });
  assert.equal(noJson.status, 415);
  const unknown = await postPolicy(f.url, f.group.id, f.worker.id, { foo: true });
  assert.equal(unknown.status, 400);

  // 越级：read-only 群不能用 workspace-write 上限。
  const readOnlyGroup = createTestGroup(f.bus, {
    name: '只读策略团队',
    workspace: f.directory,
    policy: 'read-only',
    lead: { name: 'read-only-lead', host: 'codex' },
    members: [{ name: '只读成员', host: 'codex' }],
  });
  await until(() => f.bus.running.size === 0);
  const readOnlyMember = f.bus.members(readOnlyGroup.id).find(member => member.role === 'member');
  const above = await postPolicy(f.url, readOnlyGroup.id, readOnlyMember.id, { policyCeiling: 'workspace-write' });
  assert.equal(above.status, 400);
  const aboveBody = await above.json();
  assert.match(aboveBody.error, /不能超过群策略/);

  // 运行中拒绝：不撕裂同一宿主会话。
  const runningEndpoint = f.bus.store.endpoint(f.worker.id, 'coordination');
  f.bus.running.set(runningEndpoint.id, { endpoint: runningEndpoint, abort: new AbortController(), done: Promise.resolve() });
  try {
    const busy = await postPolicy(f.url, f.group.id, f.worker.id, { allowBrowser: true });
    assert.equal(busy.status, 400);
    assert.match((await busy.json()).error, /运行中/);
  } finally {
    f.bus.running.delete(runningEndpoint.id);
  }

  // 归档团队禁止改写成员权限（server 统一 410）。
  const archived = createTestGroup(f.bus, {
    name: '归档策略团队',
    workspace: f.directory,
    lead: { name: 'archive-lead', host: 'codex' },
    members: [{ name: '归档成员', host: 'codex' }],
  });
  await until(() => f.bus.running.size === 0);
  const archivedMember = f.bus.members(archived.id).find(member => member.role === 'member');
  await f.bus.archiveGroup(archived.id);
  const archivedResponse = await postPolicy(f.url, archived.id, archivedMember.id, { allowBrowser: true });
  assert.equal(archivedResponse.status, 410);
});

test('member_policy cards approve asynchronously and fail safely after the team is archived', async t => {
  const f = await policyFixture(t);
  const leadEndpoint = f.bus.store.endpoint(f.lead.id, 'coordination');
  const conversation = f.bus.store.endpoint(f.worker.id, 'coordination');
  bindSession(f.bus, conversation, 'manual-session-card');

  const card = await f.bus.tool(leadEndpoint.id, leadEndpoint.key, 'member_policy', {
    member: f.worker.id,
    policy_ceiling: 'read-only',
    allow_browser: true,
  });
  assert.equal(card.kind, 'member_policy');
  assert.equal(card.state, 'pending');
  // 卡片 payload 使用前端依赖的 camelCase 形状；未指定字段不出现（保留现值）。
  assert.equal(card.payload.args.member, f.worker.id);
  assert.equal(card.payload.args.policyCeiling, 'read-only');
  assert.equal(card.payload.args.allowBrowser, true);
  assert.equal(Object.hasOwn(card.payload.args, 'allowShell'), false);

  const decided = f.bus.decideInteraction(card.id, { approved: true });
  assert.ok(decided instanceof Promise);
  const result = await decided;
  assert.equal(result.state, 'answered');
  const updated = f.bus.store.member(f.worker.id);
  assert.equal(updated.policy_ceiling, 'read-only');
  assert.equal(updated.allow_browser, 1);
  assert.equal(updated.allow_shell, null);
  const clearedConversation = f.bus.store.get('SELECT session FROM conversations WHERE id=?', conversation.id);
  assert.equal(clearedConversation.session, null);
  const notices = f.bus.store.all("SELECT text FROM messages WHERE group_id=? AND recipient=? AND sender='system'", f.group.id, f.worker.id);
  assert.ok(notices.some(row => /执行能力已更新为 read-only/.test(row.text)));

  // 同意后执行失败：卡片落 failed 且结果回到发起者，不能提前宣布已生效。
  const second = await f.bus.tool(leadEndpoint.id, leadEndpoint.key, 'member_policy', {
    member: f.worker.id,
    allow_shell: true,
  });
  assert.equal(second.state, 'pending');
  await f.bus.archiveGroup(f.group.id);
  await assert.rejects(() => f.bus.decideInteraction(second.id, { approved: true }), /已归档/);
  const failedRow = f.bus.store.interaction(second.id);
  assert.equal(failedRow.state, 'failed');
  assert.match(failedRow.detail, /已归档/);
  const failureMessages = f.bus.store.all("SELECT text FROM messages WHERE group_id=? AND text LIKE '%执行失败%'", f.group.id);
  assert.ok(failureMessages.length > 0);
  const successForFailedCard = f.bus.store.all("SELECT text FROM messages WHERE group_id=? AND text LIKE '%命令 允许:用户已同意,已生效%'", f.group.id);
  assert.equal(successForFailedCard.length, 0);
});

test('Panel group_member_policy creates a member_policy card and approval applies it', async t => {
  const f = await policyFixture(t);
  await f.bus.createPanelAgent({ name: 'Panel', host: 'codex', model: 'coder', reasoning_effort: 'low' });
  const agent = f.bus.panelAgent();
  const privateSession = f.bus.store.panelSession(agent.id, 'private');
  const takeover = await f.bus.panelTool(privateSession.id, privateSession.key, 'request_team_takeover', { groupId: f.group.id }, { activeTeamId: f.group.id });
  f.bus.decideInteraction(takeover.id, { approved: true });
  await until(() => f.bus.running.size === 0);

  // 工具只在协调上下文可用；私人上下文不能直接改团队权限。
  assert.throws(
    () => validatePanelTool('private', 'group_member_policy', { groupId: f.group.id, member: f.worker.id }),
    /不能使用/,
  );
  assert.doesNotThrow(
    () => validatePanelTool('coordination', 'group_member_policy', { groupId: f.group.id, member: f.worker.id }),
  );

  const coordination = f.bus.store.panelSession(agent.id, 'coordination', f.group.id);
  const card = await f.bus.panelTool(coordination.id, coordination.key, 'group_member_policy', {
    groupId: f.group.id,
    member: f.worker.id,
    policyCeiling: 'read-only',
    allowShell: false,
  }, { activeTeamId: f.group.id });
  assert.equal(card.kind, 'member_policy');
  assert.equal(card.state, 'pending');
  assert.equal(card.payload.args.member, f.worker.id);
  assert.equal(card.payload.args.policyCeiling, 'read-only');
  assert.equal(card.payload.args.allowShell, false);

  await f.bus.decideInteraction(card.id, { approved: true });
  const updated = f.bus.store.member(f.worker.id);
  assert.equal(updated.policy_ceiling, 'read-only');
  assert.equal(updated.allow_shell, 0);
});

test('runtime policy changes immediately regate dispatch (exec.write and tool.browser)', async t => {
  const f = await policyFixture(t);
  await f.bus.modelCatalog();
  const leadEndpoint = f.bus.store.endpoint(f.lead.id, 'coordination');

  let browserError;
  await assert.rejects(
    async () => {
      try {
        await f.bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
          to: f.worker.id,
          text: '打开浏览器核对页面。',
          requiredCapabilities: ['tool.browser'],
        });
      } catch (error) {
        browserError = error;
        throw error;
      }
    },
    /capability_required/,
  );
  assert.equal(browserError.code, 'capability_required');
  assert.deepEqual(browserError.details.missingCapabilities, ['tool.browser']);

  // 授权浏览器放行后，能力名片与派工门禁同步点亮。
  await f.bus.applyMemberPolicy(f.group.id, f.worker.id, { allowBrowser: true });
  const directory = await (await fetch(new URL('/api/directory', f.url))).json();
  const projected = directory.members.find(row => row.id === f.worker.id);
  assert.equal(projected.capabilityCard.effectiveCapabilities['tool.browser'], true);
  const allowed = await f.bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
    to: f.worker.id,
    text: '打开浏览器核对页面。',
    requiredCapabilities: ['tool.browser'],
  });
  assert.ok(allowed.messageId);
  await until(() => f.bus.running.size === 0);

  // 降为只读后，之前允许的 exec.write 派工立即被拦；快照名片同步收窄。
  await f.bus.applyMemberPolicy(f.group.id, f.worker.id, { policyCeiling: 'read-only' });
  let writeError;
  await assert.rejects(
    async () => {
      try {
        await f.bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
          to: f.worker.id,
          text: '请修改项目文件。',
          requiredCapabilities: ['exec.write'],
        });
      } catch (error) {
        writeError = error;
        throw error;
      }
    },
    /capability_required/,
  );
  assert.deepEqual(writeError.details.missingCapabilities, ['exec.write']);
  const snapshot = await (await fetch(new URL(`/api/snapshot?scoped=1&group=${f.group.id}`, f.url))).json();
  const snapshotMember = snapshot.members.find(row => row.id === f.worker.id);
  assert.equal(snapshotMember.capabilityCard.effectivePolicy.ceiling, 'read-only');
  assert.equal(snapshotMember.capabilityCard.effectiveCapabilities['exec.write'], false);
});
});

describe('codex-policy', () => {
test('Codex native child-agent and wait activity is interrupted instead of blocking a team turn', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-codex-policy-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: {} } } });
  if (row.method === 'thread/start') return send({ id: row.id, result: { thread: { id: 'thread-1' }, model: 'test', modelProvider: 'test', reasoningEffort: null } });
  if (row.method === 'turn/start') {
    send({ id: row.id, result: { turn: { id: 'turn-1' } } });
    setImmediate(() => {
      send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'collabAgentToolCall', tool: 'wait' } } });
    });
    return;
  }
  if (row.method === 'turn/interrupt') return send({ id: row.id, result: {} });
});
`);
  chmodSync(fake, 0o700);
  const host = createCodexHost({ command: fake });
  assert.equal(host.sessionKey({ policy: { mode: 'communication' } }), 'communication');
  assert.equal(host.sessionKey({ policy: { mode: 'read-only' } }), 'project');
  assert.equal(host.sessionKey({ policy: { mode: 'workspace-write' } }), 'project');
  assert.equal(host.supportsPolicy({ policy: { mode: 'communication', allowShell: false } }).supported, true);
  assert.equal(host.supportsPolicy({ policy: { mode: 'workspace-write', allowShell: false } }).supported, false);
  t.after(async () => {
    await host.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });

  await assert.rejects(host.run({
    endpoint: { id: 'endpoint', key: 'key', session: null },
    turnId: 'framework-turn',
    workspace: directory,
    prompt: 'wait for a teammate',
    instructions: 'Use only agent_team tools.',
    tools: [],
    policy: { mode: 'communication', allowShell: false },
    signal: new AbortController().signal,
    onSession() {},
    onAccepted() {},
    onNativeTurn() {},
    onModel() {},
    onEvent() {},
    onTool: async () => ({}),
  }), /原生子 Agent\/协同工具/);
});

test('Codex resumes an existing session when only MCP configuration order changes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-codex-order-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: { node_repl: {}, shadcn: {}, webstorm: {}, idea: {} } } } });
  if (row.method === 'thread/resume') return send({ id: row.id, result: { thread: { id: row.params.threadId }, model: 'test' } });
  if (row.method === 'thread/start') return send({ id: row.id, error: { message: 'must preserve existing session' } });
  if (row.method === 'turn/start') {
    send({ id: row.id, result: { turn: { id: 'turn-resumed' } } });
    setImmediate(() => { send({ method: 'item/completed', params: { threadId: 'original-session', turnId: 'turn-resumed', item: { type: 'agentMessage', text: 'ok' } } }); send({ method: 'turn/completed', params: { threadId: 'original-session', turn: { id: 'turn-resumed', status: 'completed' } } }); });
  }
});
`);
  chmodSync(fake, 0o700);
  const host = createCodexHost({ command: fake });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const { codexPolicyConfig } = await import('../../hosts/policies.mjs');
  const policy = { mode: 'communication', allowShell: false };
  const config = codexPolicyConfig(policy, ['webstorm', 'idea', 'node_repl', 'shadcn']);
  let resumed;
  const context = {
    endpoint: { id: 'endpoint', session: 'original-session' }, workspace: directory,
    turnId: 'framework-turn', prompt: 'report status', instructions: 'Use team tools.', tools: [], policy,
    previousPolicy: { signature: JSON.stringify({ config, tools: [] }) },
    signal: new AbortController().signal, onSession(id) { resumed = id; },
    onAccepted() {}, onNativeTurn() {}, onModel() {}, onEvent() {}, onTool: async () => ({}),
  };
  await host.run(context);
  assert.equal(resumed, 'original-session');
  await assert.rejects(host.run({ ...context, previousPolicy: { signature: JSON.stringify({ config: { ...config, 'features.shell_tool': true }, tools: [] }) } }), /工具配置/);
  await assert.rejects(host.run({ ...context, previousPolicy: { signature: JSON.stringify({ config, tools: ['old_tool'] }) } }), /工具配置/);
  await assert.rejects(host.run({ ...context, previousPolicy: null }), /工具配置/);
});

test('Codex applies member model and effort per turn without breaking session continuity', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-codex-model-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: {} } } });
  if (row.method === 'thread/resume') {
    if (row.params.config?.model_reasoning_effort) return send({ id: row.id, error: { message: 'effort must not ride in config' } });
    return send({ id: row.id, result: { thread: { id: row.params.threadId }, model: 'old-model' } });
  }
  if (row.method === 'turn/start') {
    const turnId = 'turn-' + row.params.model + '-' + (row.params.effort ?? 'none');
    send({ id: row.id, result: { turn: { id: turnId } } });
    setImmediate(() => { send({ method: 'item/completed', params: { threadId: 'session-1', turnId: turnId, item: { type: 'agentMessage', text: 'ok' } } }); send({ method: 'turn/completed', params: { threadId: 'session-1', turn: { id: turnId, status: 'completed' } } }); });
  }
});
`);
  chmodSync(fake, 0o700);
  const host = createCodexHost({ command: fake });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const policy = { mode: 'communication', allowShell: false };
  const { codexPolicyConfig } = await import('../../hosts/policies.mjs');
  const previousPolicy = { signature: JSON.stringify({ config: codexPolicyConfig(policy, []), tools: [] }) };
  let signature = null;
  const context = {
    endpoint: { id: 'endpoint', session: 'session-1' }, workspace: directory,
    turnId: 'framework-turn', prompt: 'report status', instructions: 'Use team tools.', tools: [], policy,
    previousPolicy,
    signal: new AbortController().signal, onSession() {}, onAccepted() {}, onNativeTurn() {},
    onModel() {}, onEvent() {}, onTool: async () => ({}),
    onPolicy: observation => { signature = observation.signature; },
  };
  await host.run({ ...context, modelSelection: { model_provider: null, model: 'model-a', reasoning_effort: 'low' } });
  assert.ok(signature);
  // 强度不进会话签名:同签名下换模型+强度恢复会话不应被拒
  await host.run({
    ...context,
    previousPolicy: { signature },
    modelSelection: { model_provider: null, model: 'model-b', reasoning_effort: 'high' },
  });
  assert.equal(JSON.parse(signature).config.model_reasoning_effort, undefined);
});

test('attachment policy helpers gate private sessions and build internal manifests', async () => {
  const { attachmentManifest, panelAttachmentsAllowed } = await import('../../hosts/policies.mjs');
  const { codexTurnInput } = await import('../../member/codex/index.mjs');

  // 只有带 access 的私人策略允许附件;communication 不扩大。
  assert.equal(panelAttachmentsAllowed({ mode: 'communication', allowShell: false }), false);
  assert.equal(panelAttachmentsAllowed({ mode: 'read-only', allowShell: true, access: 'read-only' }), true);
  assert.equal(panelAttachmentsAllowed({}), false);
  assert.equal(panelAttachmentsAllowed(null), false);

  // 清单包含 id/type/name/path;空清单返回空串。
  const manifest = attachmentManifest([
    { id: 'a1', mediaType: 'text/plain', name: 'a.txt', path: '/ws/.agent-team/attachments/a1' },
  ]);
  assert.ok(manifest.includes('[attachment:a1] text/plain a.txt -> /ws/.agent-team/attachments/a1'));
  assert.equal(attachmentManifest([]), '');
  assert.equal(attachmentManifest(undefined), '');

  // Codex turn 输入:正文保持原文,TXT 清单内嵌,PNG 附加 localImage。
  const input = codexTurnInput('看看附件', [
    { id: 'a1', mediaType: 'text/plain', name: 'a.txt', path: '/ws/att/a1' },
    { id: 'p1', mediaType: 'image/png', name: 'p.png', path: '/ws/att/p1' },
  ]);
  assert.equal(input.length, 2);
  assert.equal(input[0].type, 'text');
  assert.ok(input[0].text.startsWith('看看附件'));
  assert.ok(input[0].text.includes('[attachment:a1] text/plain a.txt -> /ws/att/a1'));
  assert.deepEqual(input[1], { type: 'localImage', path: '/ws/att/p1' });
  // 无附件时正文原样;多个 PNG 保持顺序。
  assert.deepEqual(codexTurnInput('plain', []).map(item => item.text), ['plain']);
  const many = codexTurnInput('x', [
    { id: 'p1', mediaType: 'image/png', name: '1.png', path: '/p1' },
    { id: 'p2', mediaType: 'image/png', name: '2.png', path: '/p2' },
  ]);
  assert.deepEqual(many.slice(1), [{ type: 'localImage', path: '/p1' }, { type: 'localImage', path: '/p2' }]);
});

test('Codex adapter forwards attachments as localImage items and refuses them in communication mode', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-codex-attach-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const record = value => writeFileSync(join(dirname(process.argv[1]), 'turn-inputs.jsonl'), JSON.stringify(value) + '\\n', { flag: 'a' });
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: {} } } });
  if (row.method === 'thread/start') return send({ id: row.id, result: { thread: { id: 'thread-att' }, model: 'test', modelProvider: 'test', reasoningEffort: null } });
  if (row.method === 'turn/start') {
    record(row.params.input);
    send({ id: row.id, result: { turn: { id: 'turn-att' } } });
    setImmediate(() => { send({ method: 'item/completed', params: { threadId: 'thread-att', turnId: 'turn-att', item: { type: 'agentMessage', text: 'ok' } } }); send({ method: 'turn/completed', params: { threadId: 'thread-att', turn: { id: 'turn-att', status: 'completed' } } }); });
    return;
  }
  if (row.method === 'turn/interrupt') return send({ id: row.id, result: {} });
});
`);
  chmodSync(fake, 0o700);
  const host = createCodexHost({ command: fake });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

  const attachments = [
    { id: 'a1', mediaType: 'text/plain', name: 'a.txt', path: join(directory, 'att', 'a1') },
    { id: 'p1', mediaType: 'image/png', name: 'p.png', path: join(directory, 'att', 'p1') },
  ];
  const base = {
    endpoint: { id: 'endpoint', key: 'key', session: null },
    turnId: 'framework-turn',
    workspace: directory,
    prompt: '读取附件',
    instructions: 'Use tools.',
    tools: [],
    attachments,
    signal: new AbortController().signal,
    onSession() {},
    onAccepted() {},
    onNativeTurn() {},
    onModel() {},
    onEvent() {},
    onTool: async () => ({}),
  };

  // 私人会话(read-only + allowShell,带 access):PNG → localImage,TXT → 内部清单,顺序保留。
  await host.run({ ...base, policy: { mode: 'read-only', allowShell: true, access: 'read-only', domain: 'project' } });
  const recorded = JSON.parse(readFileSync(join(directory, 'turn-inputs.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(recorded[0].type, 'text');
  assert.ok(recorded[0].text.startsWith('读取附件'));
  assert.ok(recorded[0].text.includes('[attachment:a1] text/plain a.txt -> '));
  assert.deepEqual(recorded[1], { type: 'localImage', path: attachments[1].path });

  // communication 模式带附件:执行前明确拒绝,不进入宿主回合。
  await assert.rejects(
    host.run({ ...base, policy: { mode: 'communication', allowShell: false } }),
    /不支持附件输入/,
  );
});
});

describe('member-execution-capabilities', () => {
const FULL = ['exec.read', 'exec.write'];

test('communication never yields execution capabilities', () => {
  for (const traits of [{}, CODEX_TRAITS, CLAUDE_TRAITS]) {
    const result = memberExecutionCapabilities(traits, { mode: 'communication', allowShell: true });
    assert.equal(result.effectivePolicy, 'communication');
    assert.deepEqual(result.capabilities, []);
  }
});

test('read-only exposes read, and only codex keeps a read-only shell', () => {
  const codex = memberExecutionCapabilities(CODEX_TRAITS, { mode: 'read-only', allowShell: true });
  assert.equal(codex.effectivePolicy, 'read-only');
  assert.deepEqual(codex.capabilities, ['exec.read', 'exec.shell']);
  assert.match(codex.reason, /只读沙箱/);

  for (const traits of [DSH_TRAITS, ZCODE_TRAITS, CLAUDE_TRAITS]) {
    const result = memberExecutionCapabilities(traits, { mode: 'read-only', allowShell: true });
    assert.deepEqual(result.capabilities, ['exec.read']);
    assert.equal(result.reason, '群策略只允许读取');
  }
});

test('codex degrades the whole class to communication without shell', () => {
  const result = memberExecutionCapabilities(CODEX_TRAITS, { mode: 'workspace-write', allowShell: false });
  assert.equal(result.effectivePolicy, 'communication');
  assert.deepEqual(result.capabilities, []);
  assert.match(result.reason, /未启用 shell/);
});

test('workspace-write keeps files, and shell follows allowShell', () => {
  for (const traits of [DSH_TRAITS, ZCODE_TRAITS]) {
    const withShell = memberExecutionCapabilities(traits, { mode: 'workspace-write', allowShell: true });
    assert.equal(withShell.effectivePolicy, 'workspace-write');
    assert.deepEqual(withShell.capabilities, [...FULL, 'exec.shell']);
    assert.equal(withShell.reason, null);

    const withoutShell = memberExecutionCapabilities(traits, { mode: 'workspace-write', allowShell: false });
    assert.deepEqual(withoutShell.capabilities, FULL);
  }
});

test('zcode explains a shell-less workspace-write differently', () => {
  const result = memberExecutionCapabilities(ZCODE_TRAITS, { mode: 'workspace-write', allowShell: false });
  assert.equal(result.reason, '未启用 shell；执行边界依赖 ZCode 会话权限模式');
});

test('claude on windows degrades to read-only', () => {
  const win = memberExecutionCapabilities(CLAUDE_TRAITS, { mode: 'workspace-write', allowShell: true, platform: 'win32' });
  assert.equal(win.effectivePolicy, 'read-only');
  assert.deepEqual(win.capabilities, ['exec.read']);
  assert.match(win.reason, /Windows/);

  const mac = memberExecutionCapabilities(CLAUDE_TRAITS, { mode: 'workspace-write', allowShell: true, platform: 'darwin' });
  assert.equal(mac.effectivePolicy, 'workspace-write');
  assert.deepEqual(mac.capabilities, [...FULL, 'exec.shell']);
});

test('read-only is checked before the platform boundary trait', () => {
  const result = memberExecutionCapabilities(CLAUDE_TRAITS, { mode: 'read-only', allowShell: false, platform: 'win32' });
  assert.equal(result.effectivePolicy, 'read-only');
  assert.equal(result.reason, '群策略只允许读取');
});

test('browser capability comes only from a real host report and respects authorization', () => {
  // 未授权、通信策略、宿主未报告可用都保持 false，并给出可读原因。
  assert.deepEqual(browserToolCapability({ effectivePolicy: 'communication', requested: true, supported: true }), {
    toolBrowser: false, browserReason: 'communication 策略下浏览器/Computer Use 工具一律禁用',
  });
  assert.equal(browserToolCapability({ effectivePolicy: 'workspace-write', requested: false, supported: true }).toolBrowser, false);
  assert.match(browserToolCapability({ effectivePolicy: 'workspace-write', requested: true, supported: false }).browserReason, /未检测到可用/);
  assert.match(browserToolCapability({ effectivePolicy: 'workspace-write', requested: true, supported: false, reason: '当前受控启动配置仅挂载 agent_team MCP' }).browserReason, /仅挂载 agent_team/);
  assert.deepEqual(browserToolCapability({ effectivePolicy: 'workspace-write', requested: true, supported: true }), {
    toolBrowser: true, browserReason: null,
  });
});

test('codex reports native browser access only when the member policy authorizes it', () => {
  const host = createCodexHost({ command: 'codex' });
  const authorized = host.executionCapabilities({ mode: 'workspace-write', allowShell: true, allowBrowser: true });
  assert.equal(authorized.toolBrowser, true);
  assert.equal(authorized.browserReason, null);
  const unauthorized = host.executionCapabilities({ mode: 'workspace-write', allowShell: true });
  assert.equal(unauthorized.toolBrowser, false);
  assert.match(unauthorized.browserReason, /allowBrowser/);
  const communication = host.executionCapabilities({ mode: 'communication', allowShell: false, allowBrowser: true });
  assert.equal(communication.toolBrowser, false);
  assert.match(communication.browserReason, /communication/);
});

const BROWSER_SERVER = { name: 'playwright', config: { command: 'npx', args: ['@playwright/mcp'] } };

/** 三家无原生浏览器开关的宿主：探测结果只能来自注入的 browserProbe，单元测试不读真实用户配置。 */
function probedHosts(browserProbe) {
  return [
    ['claude', createClaudeHost({ command: 'claude', browserProbe })],
    ['dsh', createDshHost({ command: 'dsh', browserProbe })],
    ['zcode', createZcodeHost({ command: 'zcode', browserProbe })],
  ];
}

test('claude/dsh/zcode report browser access only when the probe finds a real browser MCP', () => {
  let calls = 0;
  const browserProbe = () => { calls += 1; return { servers: [BROWSER_SERVER], reason: null }; };
  for (const [name, host] of probedHosts(browserProbe)) {
    calls = 0;
    const authorized = host.executionCapabilities({ mode: 'workspace-write', allowShell: true, allowBrowser: true });
    assert.equal(authorized.toolBrowser, true, name);
    assert.equal(authorized.browserReason, null, name);
    assert.equal(calls, 1, name);

    calls = 0;
    const unauthorized = host.executionCapabilities({ mode: 'workspace-write', allowShell: true });
    assert.equal(unauthorized.toolBrowser, false, name);
    assert.match(unauthorized.browserReason, /allowBrowser=false/, name);
    assert.equal(calls, 0, name);

    const communication = host.executionCapabilities({ mode: 'communication', allowShell: false, allowBrowser: true });
    assert.equal(communication.toolBrowser, false, name);
    assert.match(communication.browserReason, /communication/, name);
    assert.equal(calls, 0, name);
  }
});

test('claude/dsh/zcode keep browser false and pass through the probe reason', () => {
  const browserProbe = () => ({ servers: [], reason: '已开启授权，但未发现浏览器 MCP' });
  for (const [name, host] of probedHosts(browserProbe)) {
    const result = host.executionCapabilities({ mode: 'read-only', allowShell: false, allowBrowser: true });
    assert.equal(result.toolBrowser, false, name);
    assert.equal(result.browserReason, '已开启授权，但未发现浏览器 MCP', name);
  }
});

test('a throwing probe degrades to false instead of breaking capability cards', () => {
  const browserProbe = () => { throw new Error('boom'); };
  for (const [name, host] of probedHosts(browserProbe)) {
    const result = host.executionCapabilities({ mode: 'workspace-write', allowShell: true, allowBrowser: true });
    assert.equal(result.toolBrowser, false, name);
    assert.match(result.browserReason, /探测异常：boom/, name);
  }
});
});

describe('heterogeneous-teams', () => {
const CODER = {
  key: 'coder', id: 'coder', label: 'Coder', provider: 'prov-a',
  inputModalities: ['text'], contextWindow: 128000,
  reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
  defaultReasoningEffort: 'low', isDefault: true,
};
const REVIEWER = {
  key: 'reviewer', id: 'reviewer', label: 'Reviewer', provider: 'prov-b',
  inputModalities: ['text'], contextWindow: 64000,
  reasoningEfforts: [{ id: 'low', label: 'Low' }],
  defaultReasoningEffort: 'low',
};

function hostFor(hostName, models, executionCapabilities = null) {
  return {
    async listModels() {
      return { version: 1, host: hostName, source: 'test', defaultModel: models[0].key, reasoningEfforts: [], models };
    },
    ...(executionCapabilities ? { executionCapabilities } : {}),
    async run(context) {
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      if (context.endpoint.context === 'profile') {
        await context.onTool('profile_set', { text: 'ready' });
        context.onAccepted();
        return '';
      }
      context.onAccepted();
      return '';
    },
  };
}

function heterogeneousFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'heterogeneous-'));
  const codexHost = hostFor('codex', [CODER], ({ mode, allowShell, allowBrowser }) => ({
    effectivePolicy: mode === 'communication' ? 'communication' : 'workspace-write',
    capabilities: mode === 'communication' ? [] : ['exec.read', 'exec.write', ...(allowShell ? ['exec.shell'] : [])],
    reason: null,
    toolBrowser: allowBrowser === true && mode !== 'communication',
    browserReason: allowBrowser === true ? null : '成员未获浏览器/Computer Use 授权（allowBrowser=false）',
  }));
  const dshHost = hostFor('dsh', [REVIEWER], ({ mode, allowShell, allowBrowser }) => ({
    effectivePolicy: mode === 'communication' ? 'communication' : (mode === 'read-only' ? 'read-only' : 'workspace-write'),
    capabilities: mode === 'communication' ? [] : ['exec.read', 'exec.write', ...(allowShell ? ['exec.shell'] : [])],
    reason: null,
    toolBrowser: false,
    browserReason: allowBrowser === true ? '当前受控启动配置仅挂载 agent_team MCP，未放行浏览器/Computer Use MCP' : undefined,
  }));
  const hosts = new Map([['codex', codexHost], ['dsh', dshHost]]);
  const bus = new Bus({ directory, hosts });
  t.after(async () => {
    if (!bus.closing) await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论 */ }
  });
  return { bus, directory, hosts };
}

function memberNamed(bus, group, name) {
  return bus.members(group.id).find(member => member.name === name);
}

test('createGroup accepts a heterogeneous member matrix and projections carry capability cards', async t => {
  const { bus, directory } = heterogeneousFixture(t);
  await bus.modelCatalog();
  const group = bus.createGroup({
    name: '异构团队',
    workspace: directory,
    policy: 'workspace-write',
    allowShell: true,
    lead: {
      name: 'lead',
      host: 'codex',
      selection: { model_provider: 'prov-a', model: 'coder', reasoning_effort: 'high' },
    },
    members: [
      { name: '编码', host: 'dsh', selection: { model: 'reviewer', reasoning_effort: 'low' }, policyCeiling: 'workspace-write', allowShell: true, allowBrowser: true },
      { name: '审查', host: 'codex', policyCeiling: 'read-only', allowShell: false },
    ],
  });
  await until(() => bus.running.size === 0);
  assert.equal(group.policy, 'workspace-write');
  assert.equal(group.allow_shell, 1);

  const lead = memberNamed(bus, group, 'lead');
  assert.equal(lead.model, 'coder');
  assert.equal(lead.model_provider, 'prov-a');
  assert.equal(lead.reasoning_effort, 'high');

  const coder = memberNamed(bus, group, '编码');
  assert.equal(coder.host, 'dsh');
  assert.equal(coder.model, 'reviewer');
  assert.equal(coder.model_provider, 'prov-b');
  assert.equal(coder.policy_ceiling, 'workspace-write');
  assert.equal(coder.allow_shell, 1);
  assert.equal(coder.allow_browser, 1);

  const reviewer = memberNamed(bus, group, '审查');
  assert.equal(reviewer.policy_ceiling, 'read-only');
  assert.equal(reviewer.allow_shell, 0);
  assert.equal(reviewer.allow_browser, 0);

  // 目录投影：成员行保留既有字段，附带只读名片；dsh 未检测到浏览器工具时 tool.browser 保守 false。
  const projected = bus.queryDirectory().members.find(row => row.id === coder.id);
  assert.ok(projected);
  assert.equal(projected.name, '编码');
  assert.equal(projected.capabilityCard.effectivePolicy.ceiling, 'workspace-write');
  assert.equal(projected.capabilityCard.effectivePolicy.mode, 'workspace-write');
  assert.equal(projected.capabilityCard.effectiveCapabilities['exec.write'], true);
  assert.equal(projected.capabilityCard.effectiveCapabilities['tool.browser'], false);
  assert.equal(bus.overview().members.find(row => row.id === coder.id).capabilityCard.memberId, coder.id);
  assert.equal(bus.snapshot(group.id).members.find(row => row.id === reviewer.id).capabilityCard.effectivePolicy.ceiling, 'read-only');
});

test('createGroup keeps operationId replay semantics and old minimal input defaults', async t => {
  const { bus, directory } = heterogeneousFixture(t);
  await bus.modelCatalog();
  const spec = {
    name: '幂等团队',
    workspace: directory,
    lead: { name: 'lead', host: 'codex' },
    members: [{ name: '成员A', host: 'dsh' }],
    operationId: 'hetero-op-1',
  };
  const first = bus.createGroup(spec);
  const replay = bus.createGroup({ ...spec, lead: { ...spec.lead }, members: spec.members.map(member => ({ ...member })) });
  assert.equal(replay.id, first.id);
  assert.throws(
    () => bus.createGroup({ ...spec, members: [{ name: '成员A', host: 'dsh', allowBrowser: true }] }),
    /请求编号已用于不同建群内容/,
  );
  await until(() => bus.running.size === 0);

  // 旧极简入参：新字段全部取默认（继承群策略、命令继承、浏览器关闭）。
  const legacy = bus.createGroup({
    name: '旧入参',
    workspace: directory,
    lead: { name: 'old-lead', host: 'codex' },
    members: [{ name: 'old-member', host: 'dsh' }],
  });
  await until(() => bus.running.size === 0);
  const legacyMember = memberNamed(bus, legacy, 'old-member');
  assert.equal(legacyMember.policy_ceiling, null);
  assert.equal(legacyMember.allow_shell, null);
  assert.equal(legacyMember.allow_browser, 0);
  assert.equal(legacy.policy, 'workspace-write');
});

test('createGroup rejects above-ceiling policy and unresolvable explicit models', async t => {
  const { bus, directory } = heterogeneousFixture(t);
  assert.throws(
    () => bus.createGroup({
      name: '越级团队',
      workspace: directory,
      policy: 'read-only',
      lead: { name: 'lead', host: 'codex' },
      members: [{ name: '成员A', host: 'dsh', policyCeiling: 'workspace-write' }],
    }),
    /不能超过群策略/,
  );
  assert.throws(
    () => bus.createGroup({
      name: '越级主控',
      workspace: directory,
      policy: 'read-only',
      lead: { name: 'lead', host: 'codex', policyCeiling: 'workspace-write' },
    }),
    /不能超过群策略/,
  );
  // 目录未就绪时：未指定模型允许建群，显式模型严格拒绝。
  assert.throws(
    () => bus.createGroup({
      name: '无目录团队',
      workspace: directory,
      lead: { name: 'lead', host: 'codex' },
      members: [{ name: '成员A', host: 'dsh', selection: { model: 'reviewer' } }],
    }),
    /没有可用模型目录/,
  );
  const defaults = bus.createGroup({
    name: '默认模型团队',
    workspace: directory,
    lead: { name: 'lead', host: 'codex' },
    members: [{ name: '成员A', host: 'dsh' }],
  });
  await until(() => bus.running.size === 0);
  assert.equal(memberNamed(bus, defaults, '成员A').model, null);

  await bus.modelCatalog();
  assert.throws(
    () => bus.createGroup({
      name: '无效模型团队',
      workspace: directory,
      lead: { name: 'lead', host: 'codex' },
      members: [{ name: '成员A', host: 'dsh', selection: { model: 'nope' } }],
    }),
    /不在该成员宿主目录/,
  );
  assert.throws(
    () => bus.createGroup({
      name: '无效强度团队',
      workspace: directory,
      lead: { name: 'lead', host: 'codex' },
      members: [{ name: '成员A', host: 'dsh', selection: { model: 'reviewer', reasoning_effort: 'high' } }],
    }),
    /思考强度不受支持/,
  );
});

test('member group_add card carries member config and lands it after approval', async t => {
  const { bus, directory } = heterogeneousFixture(t);
  await bus.modelCatalog();
  const group = bus.createGroup({
    name: '加人团队',
    workspace: directory,
    policy: 'workspace-write',
    lead: { name: 'lead', host: 'codex' },
  });
  await until(() => bus.running.size === 0);
  const lead = memberNamed(bus, group, 'lead');
  const endpoint = bus.store.endpoint(lead.id, 'coordination');

  const card = await bus.tool(endpoint.id, endpoint.key, 'group_add', {
    name: '新人',
    host: 'dsh',
    selection: { model: 'reviewer', reasoning_effort: 'low' },
    policy_ceiling: 'read-only',
    allow_shell: false,
    allow_browser: true,
  });
  assert.equal(card.kind, 'group_add');
  assert.equal(card.state, 'pending');
  assert.equal(card.payload.args.member ?? card.payload.args.name, '新人');
  assert.equal(card.payload.args.selection.model, 'reviewer');
  assert.equal(card.payload.args.policyCeiling, 'read-only');
  assert.equal(card.payload.args.allowShell, false);
  assert.equal(card.payload.args.allowBrowser, true);
  assert.equal(bus.members(group.id).some(member => member.name === '新人'), false);

  await bus.decideInteraction(card.id, { approved: true });
  await until(() => bus.running.size === 0);
  const added = memberNamed(bus, group, '新人');
  assert.equal(added.model, 'reviewer');
  assert.equal(added.policy_ceiling, 'read-only');
  assert.equal(added.allow_shell, 0);
  assert.equal(added.allow_browser, 1);

  // 群策略天花板与显式模型同样在工具入口同步拒绝。
  const readOnlyGroup = bus.createGroup({
    name: '只读加人团队',
    workspace: directory,
    policy: 'read-only',
    lead: { name: '只读主控', host: 'codex' },
  });
  await until(() => bus.running.size === 0);
  const readOnlyLead = memberNamed(bus, readOnlyGroup, '只读主控');
  const readOnlyEndpoint = bus.store.endpoint(readOnlyLead.id, 'coordination');
  await assert.rejects(
    () => bus.tool(readOnlyEndpoint.id, readOnlyEndpoint.key, 'group_add', { name: '越级', host: 'dsh', policy_ceiling: 'workspace-write' }),
    /不能超过群策略/,
  );
  await assert.rejects(
    () => bus.tool(endpoint.id, endpoint.key, 'group_add', { name: '坏模型', host: 'dsh', selection: { model: 'nope' } }),
    /不在该成员宿主目录/,
  );
  assert.equal(bus.members(readOnlyGroup.id).some(member => member.name === '越级'), false);
  // 成员工具面不暴露 member_policy（无法自我提权），主 Agent 才可用。
  assert.throws(() => validateTool('member', 'member_policy', { member: '新人' }, 'coordination'), /不可使用/);
  assert.doesNotThrow(() => validateTool('lead', 'member_policy', { member: '新人' }, 'coordination'));
});

test('Panel team_create accepts memberConfigs and Panel group_add applies member config', async t => {
  const { bus, directory } = heterogeneousFixture(t);
  await bus.modelCatalog();
  await bus.createPanelAgent({ name: 'Panel', host: 'codex', model: 'coder', reasoning_effort: 'low' });
  const agent = bus.panelAgent();
  const privateSession = bus.store.panelSession(agent.id, 'private');
  const group = await bus.panelTool(privateSession.id, privateSession.key, 'team_create', {
    name: 'Panel 异构团队',
    workspace: directory,
    policy: 'workspace-write',
    allowShell: false,
    memberConfigs: [
      { name: '编码', host: 'dsh', model: 'reviewer', reasoningEffort: 'low', policyCeiling: 'workspace-write', allowShell: true, allowBrowser: true },
      { name: '审查', host: 'codex', policyCeiling: 'read-only' },
    ],
  });
  await until(() => bus.running.size === 0);
  assert.equal(group.policy, 'workspace-write');
  assert.equal(group.allow_shell, 0);
  const coder = memberNamed(bus, group, '编码');
  assert.equal(coder.model, 'reviewer');
  assert.equal(coder.policy_ceiling, 'workspace-write');
  assert.equal(coder.allow_browser, 1);
  assert.equal(memberNamed(bus, group, '审查').policy_ceiling, 'read-only');

  // members 与 memberConfigs 重名冲突按建群重名校验拒绝。
  await assert.rejects(
    () => bus.panelTool(privateSession.id, privateSession.key, 'team_create', {
      name: '重名团队',
      workspace: directory,
      members: '重复=codex',
      memberConfigs: [{ name: '重复', host: 'dsh' }],
    }),
    /重复/,
  );
  await assert.rejects(
    () => bus.panelTool(privateSession.id, privateSession.key, 'team_create', {
      name: '坏模型团队',
      workspace: directory,
      memberConfigs: [{ name: '坏模型', host: 'dsh', model: 'nope' }],
    }),
    /不在该成员宿主目录/,
  );

  // Panel group_add 直连添加，同样按成员字段落库。
  const coordination = bus.store.panelSession(agent.id, 'coordination', group.id);
  const added = await bus.panelTool(coordination.id, coordination.key, 'group_add', {
    groupId: group.id,
    name: '新人',
    host: 'dsh',
    model: 'reviewer',
    reasoning_effort: 'low',
    policyCeiling: 'read-only',
    allowShell: false,
    allowBrowser: true,
  }, { activeTeamId: group.id });
  await until(() => bus.running.size === 0);
  assert.equal(added.name, '新人');
  assert.equal(added.policy_ceiling, 'read-only');
  assert.equal(added.allow_shell, 0);
  assert.equal(added.allow_browser, 1);
});

test('read-only host with readOnlyKeepsShell retains exec.shell and receives allowShell=true at dispatch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'readonly-shell-'));
  const seenPolicies = [];
  const codexLikeHost = {
    async listModels() {
      return { version: 1, host: 'codex', source: 'test', defaultModel: CODER.key, reasoningEfforts: [], models: [CODER] };
    },
    executionCapabilities({ mode, allowShell, allowBrowser }) {
      if (mode === 'communication') return { effectivePolicy: 'communication', capabilities: [], toolBrowser: false };
      if (!allowShell) return { effectivePolicy: 'communication', capabilities: [], reason: 'no shell', toolBrowser: false };
      return {
        effectivePolicy: mode === 'read-only' ? 'read-only' : 'workspace-write',
        capabilities: mode === 'read-only' ? ['exec.read', 'exec.shell'] : ['exec.read', 'exec.write', 'exec.shell'],
        reason: mode === 'read-only' ? '群策略只允许读取，shell 运行在只读沙箱' : null,
        toolBrowser: allowBrowser === true,
        browserReason: allowBrowser === true ? null : 'allowBrowser=false',
      };
    },
    supportsPolicy({ policy }) {
      return policy.mode === 'communication' || policy.allowShell
        ? { supported: true }
        : { supported: false, reason: '需要沙箱命令' };
    },
    async run(context) {
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      if (context.endpoint.context === 'profile') {
        await context.onTool('profile_set', { text: 'ready' });
        context.onAccepted();
        return '';
      }
      seenPolicies.push(context.policy);
      context.onAccepted();
      return '';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['codex', codexLikeHost]]) });
  t.after(async () => {
    if (!bus.closing) await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  });
  await bus.modelCatalog();
  const group = bus.createGroup({
    name: '只读沙箱命令团',
    workspace: directory,
    policy: 'workspace-write',
    allowShell: true,
    lead: { name: 'lead', host: 'codex' },
    members: [{ name: '视觉验收', host: 'codex', policyCeiling: 'read-only', allowBrowser: true }],
  });
  await until(() => bus.running.size === 0);

  const lead = memberNamed(bus, group, 'lead');
  const reviewer = memberNamed(bus, group, '视觉验收');
  const card = bus.snapshot(group.id).members.find(m => m.id === reviewer.id).capabilityCard;
  assert.equal(card.effectiveCapabilities['exec.shell'], true);
  assert.equal(card.effectiveCapabilities['tool.browser'], true);

  const leadEp = bus.store.endpoint(lead.id, 'coordination');
  await bus.tool(leadEp.id, leadEp.key, 'send', {
    to: reviewer.id,
    text: '只读并检查界面',
    requiredCapabilities: ['exec.read', 'tool.browser'],
  });
  await until(() => seenPolicies.length > 0 && bus.running.size === 0);
  assert.equal(seenPolicies[0].mode, 'read-only');
  assert.equal(seenPolicies[0].allowShell, true);
  assert.equal(seenPolicies[0].allowBrowser, true);
});

function runGit(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('workflowTemplate and member worktree isolation work end-to-end across HTTP and lifecycle', async t => {
  const root = mkdtempSync(join(tmpdir(), 'spec3-wt-e2e-'));
  const repo = join(root, 'repo');
  const nonGit = join(root, 'non-git');
  const dataDir = join(root, 'data');
  mkdirSync(repo, { recursive: true });
  mkdirSync(nonGit, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  runGit(repo, ['init']);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(repo, 'README.md'), '# Repo Root\n');
  runGit(repo, ['add', 'README.md']);
  runGit(repo, ['commit', '-m', 'init']);

  const seenWorkspaces = new Map();
  const stubHost = {
    async listModels() {
      return { version: 1, host: 'codex', source: 'test', defaultModel: CODER.key, reasoningEfforts: [], models: [CODER] };
    },
    executionCapabilities({ mode, allowShell }) {
      if (mode === 'communication') return { effectivePolicy: 'communication', capabilities: [] };
      return {
        effectivePolicy: mode === 'read-only' ? 'read-only' : 'workspace-write',
        capabilities: mode === 'read-only' ? ['exec.read', 'exec.shell'] : ['exec.read', 'exec.write', ...(allowShell ? ['exec.shell'] : [])],
      };
    },
    async run(context) {
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      if (context.endpoint.context === 'profile') {
        await context.onTool('profile_set', { text: 'ready' });
        context.onAccepted();
        return '';
      }
      const memberId = context.endpoint.member_id;
      seenWorkspaces.set(memberId, context.workspace);
      writeFileSync(join(context.workspace, `${memberId}.txt`), `written by ${memberId}\n`);
      context.onAccepted();
      return '';
    },
  };

  const server = await startServer({ directory: dataDir, hosts: new Map([['codex', stubHost]]) });
  const { bus, url: rawUrl } = server;
  const url = rawUrl.replace(/\/$/, '');
  t.after(async () => {
    await server.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  });

  // 强前置校验：非 Git、lead、仅沟通均同步拒绝，绝不静默回退共享主目录。
  assert.throws(() => bus.createGroup({
    name: '非仓库', workspace: nonGit, lead: { name: 'lead', host: 'codex' },
    members: [{ name: 'A', host: 'codex', workspaceMode: 'worktree' }],
  }), /Git 仓库根目录/);
  assert.throws(() => bus.createGroup({
    name: '主控禁wt', workspace: repo, lead: { name: 'lead', host: 'codex', workspaceMode: 'worktree' },
  }), /不支持 worktree 隔离/);
  assert.throws(() => bus.createGroup({
    name: '仅沟通禁wt', workspace: repo, policy: 'workspace-write', lead: { name: 'lead', host: 'codex' },
    members: [{ name: 'A', host: 'codex', policyCeiling: 'communication', workspaceMode: 'worktree' }],
  }), /不需要 worktree 隔离/);

  // 建群：standard-dev 模板 + 两个并发写作者各得独立 worktree。
  const templates = await fetch(`${url}/api/workflow-templates`).then(r => r.json());
  assert.equal(templates[0].id, 'standard-dev');

  const createRes = await fetch(`${url}/api/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationId: 'spec3-create-1',
      name: '并行研发团',
      workspace: repo,
      workflowTemplate: 'standard-dev',
      policy: 'workspace-write',
      allowShell: true,
      lead: { name: 'lead', host: 'codex' },
      members: [
        { name: 'coderA', host: 'codex', workspaceMode: 'worktree' },
        { name: 'coderB', host: 'codex', workspaceMode: 'worktree' },
        { name: 'reviewer', host: 'codex', policyCeiling: 'read-only', workspaceMode: 'inherit' },
      ],
    }),
  });
  assert.equal(createRes.status, 200);
  const group = await createRes.json();
  assert.equal(group.workflow_template, 'standard-dev');
  await until(() => bus.running.size === 0);

  const lead = memberNamed(bus, group, 'lead');
  const coderA = memberNamed(bus, group, 'coderA');
  const coderB = memberNamed(bus, group, 'coderB');
  const reviewer = memberNamed(bus, group, 'reviewer');
  assert.equal(coderA.workspace_mode, 'worktree');
  assert.equal(coderB.workspace_mode, 'worktree');
  assert.equal(reviewer.workspace_mode, 'inherit');
  assert.notEqual(coderA.worktree_path, coderB.worktree_path);

  // 派工执行：两位并发写作者的 context.workspace 各自指向独立 worktree，主仓库无未跟踪污染。
  const leadEp = bus.store.endpoint(lead.id, 'coordination');
  await bus.tool(leadEp.id, leadEp.key, 'send', { to: coderA.id, text: '写文件 A' });
  await bus.tool(leadEp.id, leadEp.key, 'send', { to: coderB.id, text: '写文件 B' });
  await until(() => seenWorkspaces.size === 2 && bus.running.size === 0);
  assert.equal(seenWorkspaces.get(coderA.id), coderA.worktree_path);
  assert.equal(seenWorkspaces.get(coderB.id), coderB.worktree_path);
  assert.equal(existsSync(join(repo, `${coderA.id}.txt`)), false);
  assert.equal(existsSync(join(repo, `${coderB.id}.txt`)), false);

  // worktree 状态与受限文件预览路由。
  const wtStatuses = await fetch(`${url}/api/teams/${group.id}/worktrees`).then(r => r.json());
  assert.equal(wtStatuses.length, 2);
  assert.equal(wtStatuses.find(w => w.memberId === coderA.id).untrackedCount, 1);

  const previewOk = await fetch(`${url}/api/teams/${group.id}/file-preview?path=README.md`);
  assert.equal(previewOk.status, 200);
  assert.match((await previewOk.json()).content, /Repo Root/);
  const previewEscape = await fetch(`${url}/api/teams/${group.id}/file-preview?path=../non-git/no.md`);
  assert.equal(previewEscape.status, 403);

  // coderA 还有未提交改动时：普通清理返回 409 保守保留；提交后安全合入主工作区。
  const removeConflict = await fetch(`${url}/api/teams/${group.id}/members/${coderA.id}/worktree/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(removeConflict.status, 409);

  runGit(coderA.worktree_path, ['add', `${coderA.id}.txt`]);
  runGit(coderA.worktree_path, ['commit', '-m', 'coderA work']);
  const mergeRes = await fetch(`${url}/api/teams/${group.id}/members/${coderA.id}/worktree/merge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(mergeRes.status, 200);
  assert.equal((await mergeRes.json()).merged, true);
  assert.equal(readFileSync(join(repo, `${coderA.id}.txt`), 'utf8').replace(/\r\n/g, '\n'), `written by ${coderA.id}\n`);

  // coderA 已合入且干净：自动安全清理切回 inherit；coderB 含未提交文件：removeMember 保守保留目录。
  const removeClean = await fetch(`${url}/api/teams/${group.id}/members/${coderA.id}/worktree/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(removeClean.status, 200);
  assert.equal(memberNamed(bus, group, 'coderA').workspace_mode, 'inherit');

  const removedB = await bus.removeMember(group.id, coderB.id);
  assert.ok(removedB.retainedWorktree?.retained);
  assert.equal(existsSync(coderB.worktree_path), true);

  // 通过 addMember 再加一名 worktree 成员：模拟磁盘 worktree 缺失时回合必须拦截且不回退主工作区；
  // 修复或重建另一名干净 worktree 后删群，干净成员自动清理，脏/未合入成员保守保留。
  const addedC = await bus.addMember(group.id, { name: 'coderC', host: 'codex', workspaceMode: 'worktree' });
  await until(() => bus.running.size === 0);
  const pathC = realpathSync(addedC.worktree_path);
  rmSync(pathC, { recursive: true, force: true });
  await bus.tool(leadEp.id, leadEp.key, 'send', { to: addedC.id, text: 'worktree 已删除应阻断执行' });
  await until(() => bus.running.size === 0);
  assert.equal(existsSync(join(repo, `${addedC.id}.txt`)), false, 'worktree 缺失时绝不得回退在主工作区写入');

  const addedD = await bus.addMember(group.id, { name: 'coderD', host: 'codex', workspaceMode: 'worktree' });
  await until(() => bus.running.size === 0);
  const pathD = realpathSync(addedD.worktree_path);

  const archived = await bus.archiveGroup(group.id);
  assert.equal(archived.state, 'archived');
  const deleted = await bus.deleteGroup(group.id, { archivedOnly: true });
  assert.equal(deleted.deleted, group.id);
  assert.equal(existsSync(pathD), false);
  assert.equal(existsSync(coderB.worktree_path), true);
  assert.equal(deleted.retainedWorktrees?.some(item => item.memberId === coderB.id), true);
});
});

describe('model-policy-presets', () => {
async function setup(t) {
  return serverScenario(t);
}

test('model policy presets CRUD via bus', async t => {
  const { server } = await setup(t);
  const bus = server.bus;
  const created = bus.createModelPolicyPreset({ name: '精简成本', mode: 'user', rules: '成本优先的自定义规则' });
  assert.equal(created.name, '精简成本');
  assert.equal(created.mode, 'user');
  assert.equal(bus.modelPolicyPresets().length, 1);

  // 重命名 + 重名拒绝
  const renamed = bus.renameModelPolicyPreset(created.id, '严格审查');
  assert.equal(renamed.name, '严格审查');
  bus.createModelPolicyPreset({ name: '精简成本', rules: '另一份规则' });
  assert.throws(() => bus.renameModelPolicyPreset(renamed.id, '精简成本'), /已存在/);

  // 自建配置恒为用户配置(智能策略是代码内置的,不可自建)
  const smartAttempt = bus.createModelPolicyPreset({ name: '误建智能', mode: 'smart', rules: '规则' });
  assert.equal(smartAttempt.mode, 'user');

  // 覆盖保存 + normalize(空规则回填默认用户模板)
  const saved = bus.saveModelPolicyPreset(renamed.id, { rules: '' });
  assert.equal(saved.mode, 'user');
  assert.ok(saved.rules.length > 0, '空规则回填默认用户模板');

  // 正在使用的配置不允许删除:引用保持不变
  const active = bus.createModelPolicyPreset({ name: '待删激活', rules: '激活中规则' });
  bus.updateModelPolicy({ mode: 'user', rules: '激活中规则', presetId: active.id });
  assert.equal(bus.modelPolicy().preset_id, active.id);
  assert.throws(() => bus.deleteModelPolicyPreset(active.id), /正在使用中/);
  assert.equal(bus.modelPolicy().preset_id, active.id, '拒绝删除后引用保持不变');
  assert.ok(bus.modelPolicyPresets().some(preset => preset.id === active.id), '配置仍然存在');

  // 切走后即可删除
  bus.updateModelPolicy({ mode: 'user', rules: '换成别的规则' });
  assert.deepEqual(bus.deleteModelPolicyPreset(active.id), { deleted: active.id });

  // 删除 + 不存在防护
  assert.deepEqual(bus.deleteModelPolicyPreset(saved.id), { deleted: saved.id });
  assert.throws(() => bus.deleteModelPolicyPreset(saved.id), /不存在/);
});

test('model policy presets validate name and rules', async t => {
  const { server } = await setup(t);
  const bus = server.bus;
  assert.throws(() => bus.createModelPolicyPreset({ name: '  ', rules: 'x' }), /名称/);
  assert.throws(() => bus.createModelPolicyPreset({ name: 'x'.repeat(61), rules: 'x' }), /名称/);
  assert.throws(() => bus.createModelPolicyPreset({ name: '好', rules: 'x'.repeat(48001) }), /过长/);
  // 模式不由调用方指定:自建配置恒为用户配置
  assert.equal(bus.createModelPolicyPreset({ name: '好', mode: 'unknown', rules: 'x' }).mode, 'user');
});

test('activating a policy records only the explicitly requested source preset', async t => {
  const { server } = await setup(t);
  const bus = server.bus;
  const first = bus.createModelPolicyPreset({ name: '配置A', mode: 'user', rules: '同一份规则' });
  const second = bus.createModelPolicyPreset({ name: '配置B', mode: 'user', rules: '同一份规则' });
  assert.notEqual(first.id, second.id, '配置有唯一 id');

  // 显式指定来源:即使内容相同也记录为指定那一条
  const activated = bus.updateModelPolicy({ mode: 'user', rules: '同一份规则', presetId: second.id });
  assert.equal(activated.preset_id, second.id);

  // 不指定来源时不得靠文本猜测:同文配置不会被误认作来源
  const unsourced = bus.updateModelPolicy({ mode: 'user', rules: '同一份规则' });
  assert.equal(unsourced.preset_id, null);

  // 内置默认规则用哨兵 id 记录
  const builtin = bus.updateModelPolicy({ mode: 'user', rules: '采用用户配置模型策略。', presetId: '__builtin_default__' });
  assert.equal(builtin.preset_id, '__builtin_default__');

  // 手动编辑的规则没有来源
  const manual = bus.updateModelPolicy({ mode: 'user', rules: '手写的新规则' });
  assert.equal(manual.preset_id, null);

  // 不存在的配置 id 被拒绝
  assert.throws(() => bus.updateModelPolicy({ mode: 'user', rules: 'x', presetId: 'missing' }), /配置不存在/);
});

test('model policy presets HTTP routes', async t => {
  const { url } = await setup(t);
  const create = await fetch(new URL('/api/model-policy/presets', url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP配置', mode: 'user', rules: '规则内容' }),
  });
  assert.equal(create.status, 200);
  const preset = await create.json();
  assert.equal(preset.name, 'HTTP配置');

  const rename = await fetch(new URL(`/api/model-policy/presets/${preset.id}/rename`, url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP改名' }),
  });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).name, 'HTTP改名');

  const save = await fetch(new URL(`/api/model-policy/presets/${preset.id}/save`, url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'smart', rules: '新内容' }),
  });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).rules, '新内容');

  const list = await (await fetch(new URL('/api/model-policy/presets', url))).json();
  assert.equal(list.length, 1);

  const bad = await fetch(new URL('/api/model-policy/presets', url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP改名', mode: 'user', rules: 'x' }),
  });
  assert.equal(bad.status, 400);

  const removed = await fetch(new URL(`/api/model-policy/presets/${preset.id}/delete`, url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(removed.status, 200);
});
});
