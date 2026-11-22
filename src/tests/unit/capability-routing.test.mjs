// 统一能力路由：模型维与执行维都只做投影，不推测；不确定一律 'unknown'/null 并保守拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCatalog } from '../../hosts/catalog.mjs';
import {
  ROUTING_CAPABILITY_IDS,
  TOOL_BROWSER_SUPPORTED,
  buildCapabilityCard,
  capabilityRequirementError,
  capabilityRow,
  dispatchRequirements,
  evaluateDispatchRequirements,
  executionCapabilityMap,
  hasDispatchRequirements,
  mediaCapabilityRequirements,
  messageRequirements,
  normalizeRequiredCapabilities,
  projectModelCapabilities,
  resolveCatalogModel,
  teamCapabilityView,
} from '../../hosts/capability-routing.mjs';

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
  assert.equal(TOOL_BROWSER_SUPPORTED, false);
  const catalog = catalogOf([VISION]);
  const card = cardFor({
    catalog,
    selection: { model: 'vision' },
    policy: { requested: 'read-only', effective: 'read-only', capabilities: ['exec.read'], reason: '群策略只允许读取' },
  });
  assert.equal(card.memberId, 'm1');
  assert.equal(card.model.id, 'vision');
  assert.equal(card.model.knownInCatalog, true);
  assert.deepEqual(card.effectivePolicy, { ceiling: 'read-only', mode: 'read-only', reason: '群策略只允许读取' });
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
  assert.match(execGap.reasons[2], /tool.browser/);

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
