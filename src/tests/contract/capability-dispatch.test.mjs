import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { createTestGroup, fakeHost } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';
import * as messagesAgg from '../../aggregates/messages.mjs';
import * as conversationsAgg from '../../aggregates/conversations.mjs';

// 能力名片与派工门禁的公共入口契约:
// - members 返回的成员保留既有字段,并附带只读能力名片;
// - 成员 send 的首检在写库前拒绝,旧 file.* 别名归一化,普通 send/note 零拦截;
// - 执行前复核按最新模型选择重算,整批/部分拦截都不拉起宿主进程。

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
