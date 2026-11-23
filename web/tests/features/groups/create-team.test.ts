// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { RouterLink } from 'vue-router';
import type { Group, HostStatus, ModelCatalogResponse } from '@/shared/api/raw-types';
import CreateTeam from '@/features/groups/CreateTeam.vue';
import {
  buildCreateGroupBody,
  clampPolicyCeiling,
  createEmptyDraft,
  memberSelection,
  newDraftMember,
  policyCeilingOptions,
  presetMembers,
  restoreDraft,
} from '@/features/groups/create-team-model';

// 建群矩阵的行为级测试:API、宿主列表与模型选择器全部替身,
// 只断言「填了什么 → 提交到 api.createGroup 的完整矩阵」与策略收敛规则。
const mocks = vi.hoisted(() => ({
  modelCatalog: vi.fn(),
  probeHosts: vi.fn(),
  chooseDirectory: vi.fn(),
  createGroup: vi.fn(),
  sendTeamDirective: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/shared/api/client', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    api: {
      modelCatalog: mocks.modelCatalog,
      probeHosts: mocks.probeHosts,
      chooseDirectory: mocks.chooseDirectory,
      createGroup: mocks.createGroup,
      sendTeamDirective: mocks.sendTeamDirective,
    },
    ApiError,
  };
});

vi.mock('vue-router', async () => {
  const { defineComponent, h } = await import('vue');
  const RouterLinkStub = defineComponent({
    name: 'RouterLink',
    props: { to: { type: [String, Object], default: '' } },
    setup(_props, { slots }) {
      return () => h('a', slots.default?.());
    },
  });
  return { useRouter: () => ({ push: mocks.push }), RouterLink: RouterLinkStub };
});

vi.mock('@/features/settings/HostStatuses.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'HostStatusesStub',
      props: { active: Boolean, selectable: Boolean, selected: String },
      emits: ['select'],
      setup(_props, { emit }) {
        return () => h('div', { 'data-testid': 'host-statuses' }, ['dsh', 'codex'].map((host) => h('button', {
          type: 'button',
          'data-host': host,
          onClick: () => emit('select', host),
        }, host)));
      },
    }),
  };
});

vi.mock('@/features/groups/MemberModelField.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'MemberModelFieldStub',
      props: {
        hosts: { type: Array, default: () => [] },
        host: { type: String, default: '' },
        modelProvider: { type: String, default: '' },
        model: { type: String, default: '' },
        reasoningEffort: { type: String, default: '' },
        disabled: Boolean,
      },
      emits: ['change'],
      setup(props, { emit }) {
        const model = () => (props.host === 'codex'
          ? { model_provider: 'openai', model: 'gpt-5-codex' }
          : { model_provider: 'deepseek', model: 'deepseek-v3' });
        return () => h('div', { 'data-testid': 'model-field', 'data-host': props.host, 'data-model': props.model }, [
          h('button', {
            type: 'button',
            'data-testid': 'pick-model',
            disabled: props.disabled,
            onClick: () => emit('change', { host: props.host, ...model(), reasoning_effort: 'high' }),
          }, 'pick'),
          h('button', {
            type: 'button',
            'data-testid': 'clear-model',
            disabled: props.disabled,
            onClick: () => emit('change', { host: props.host, model_provider: '', model: '', reasoning_effort: '' }),
          }, 'clear'),
        ]);
      },
    }),
  };
});

// reka Select 在 happy-dom 下不便展开,替身为「点击带 data-value 的选项按钮即更新 v-model」。
vi.mock('@/components/ui/select', async () => {
  const { defineComponent, h, inject, provide } = await import('vue');
  const handlerKey = Symbol('select-handler');
  const Select = defineComponent({
    name: 'SelectStub',
    props: { modelValue: { type: [String, Number, Boolean], default: undefined }, disabled: Boolean },
    emits: ['update:modelValue'],
    setup(props, { slots, emit }) {
      provide(handlerKey, (value: string) => {
        if (!props.disabled) emit('update:modelValue', value);
      });
      return () => h('div', { class: 'select-stub' }, slots.default?.());
    },
  });
  const passthrough = (name: string) => defineComponent({
    name,
    setup(_props, { slots }) {
      return () => h('div', slots.default?.());
    },
  });
  const SelectItem = defineComponent({
    name: 'SelectItemStub',
    props: { value: { type: [String, Number], default: '' } },
    setup(props, { slots }) {
      const select = inject<(value: string) => void>(handlerKey);
      return () => h('button', {
        type: 'button',
        'data-value': String(props.value),
        onClick: () => select?.(String(props.value)),
      }, slots.default?.());
    },
  });
  return {
    Select,
    SelectTrigger: passthrough('SelectTriggerStub'),
    SelectValue: passthrough('SelectValueStub'),
    SelectContent: passthrough('SelectContentStub'),
    SelectGroup: passthrough('SelectGroupStub'),
    SelectItem,
  };
});

const DSH_CATALOG = {
  version: 1,
  host: 'dsh',
  source: 'test',
  defaultModel: 'deepseek-v3',
  reasoningEfforts: [{ id: 'high', label: '高' }],
  models: [{
    key: 'deepseek-v3',
    id: 'deepseek-v3',
    label: 'DeepSeek V3',
    provider: 'deepseek',
    reasoningEfforts: [{ id: 'high', label: '高' }],
    isDefault: true,
  }],
};

const CODEX_CATALOG = {
  version: 1,
  host: 'codex',
  source: 'test',
  defaultModel: 'gpt-5-codex',
  reasoningEfforts: [{ id: 'high', label: '高' }],
  models: [{
    key: 'gpt-5-codex',
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex',
    provider: 'openai',
    reasoningEfforts: [{ id: 'high', label: '高' }],
    isDefault: true,
  }],
};

const CATALOG: ModelCatalogResponse = {
  version: 1,
  generatedAt: '2026-11-23T00:00:00.000Z',
  cached: false,
  hosts: [
    { host: 'dsh', ok: true, catalog: DSH_CATALOG },
    { host: 'codex', ok: true, catalog: CODEX_CATALOG },
  ],
};

const HOSTS: HostStatus[] = [
  { name: 'dsh', status: 'available' },
  { name: 'codex', status: 'available' },
];

const GROUP: Group = {
  id: 'group-new',
  name: '异构团队',
  workspace: '/tmp/workspace',
  lead: 'lead-member',
  created: '2026-11-23T00:00:00.000Z',
};

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.modelCatalog.mockResolvedValue(CATALOG);
  mocks.probeHosts.mockResolvedValue(HOSTS);
  mocks.chooseDirectory.mockResolvedValue({ path: null });
  mocks.createGroup.mockResolvedValue(GROUP);
  mocks.sendTeamDirective.mockResolvedValue({ seq: 1 });
  mocks.push.mockResolvedValue(undefined);
});

async function settle() {
  await flushPromises();
  await nextTick();
  await flushPromises();
}

async function mountCreateTeam() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = mount(CreateTeam, {
    global: {
      plugins: [[VueQueryPlugin, { queryClient }]],
      components: { RouterLink },
    },
  });
  await settle();
  return wrapper;
}

type Page = Awaited<ReturnType<typeof mountCreateTeam>>;

function buttonByText(wrapper: Page, text: string) {
  const button = wrapper.findAll('button').find((item) => item.text().trim() === text);
  if (!button) throw new Error('找不到按钮：' + text);
  return button;
}

async function fillBasics(wrapper: Page) {
  await wrapper.find('#team-name').setValue('异构团队');
  await wrapper.find('#team-request').setValue('把接口拆开实现');
  await wrapper.find('#team-directory').setValue('/tmp/workspace');
}

async function selectDefaultHost(wrapper: Page, host = 'dsh') {
  await wrapper.find('[data-host="' + host + '"]').trigger('click');
  await nextTick();
}

async function chooseOption(wrapper: Page, testId: string, value: string) {
  const select = wrapper.find('[data-testid="' + testId + '"]');
  expect(select.exists()).toBe(true);
  const option = select.findAll('button').find((item) => item.attributes('data-value') === value);
  if (!option) throw new Error('找不到选项 ' + value + '：' + select.html());
  await option.trigger('click');
  await nextTick();
}

async function clickSubmit(wrapper: Page) {
  const submit = buttonByText(wrapper, '创建并发送需求');
  expect(submit.attributes('disabled')).toBeUndefined();
  // happy-dom 不会由按钮 click 合成 form submit,直接触发提交事件。
  await wrapper.find('form').trigger('submit');
  await settle();
}

async function confirmCreate(wrapper: Page) {
  await clickSubmit(wrapper);
  expect(wrapper.find('[data-testid="create-team-confirm"]').exists()).toBe(true);
  await buttonByText(wrapper, '确认创建').trigger('click');
  await settle();
}

describe('create-team-model 纯逻辑', () => {
  it('成员权限上限只能向下收敛，更严档位保留', () => {
    expect(clampPolicyCeiling('read-only', 'workspace-write')).toBe('read-only');
    expect(clampPolicyCeiling('communication', 'read-only')).toBe('communication');
    expect(clampPolicyCeiling('workspace-write', 'read-only')).toBe('');
    expect(clampPolicyCeiling('read-only', 'read-only')).toBe('read-only');
    expect(clampPolicyCeiling('bogus', 'workspace-write')).toBe('');
  });

  it('可选上限只出现比群策略更严的档位', () => {
    expect(policyCeilingOptions('workspace-write')).toEqual(['read-only', 'communication']);
    expect(policyCeilingOptions('read-only')).toEqual(['communication']);
    expect(policyCeilingOptions('communication')).toEqual([]);
  });

  it('未选模型时省略 selection，避免后端拒绝部分选择', () => {
    expect(memberSelection(newDraftMember({ reasoning_effort: 'high' }))).toBeUndefined();
    expect(memberSelection(newDraftMember({ model_provider: 'deepseek' }))).toBeUndefined();
    expect(memberSelection(newDraftMember({ model_provider: 'deepseek', model: 'deepseek-v3', reasoning_effort: 'high' })))
      .toEqual({ model_provider: 'deepseek', model: 'deepseek-v3', reasoning_effort: 'high' });
  });

  it('提交体按完整矩阵组装，空名称协作成员不创建，communication 关闭浏览器与命令', () => {
    const form = createEmptyDraft();
    form.name = '异构团队';
    form.text = '把接口拆开实现';
    form.workspace = '/tmp/workspace';
    form.host = 'dsh';
    form.members = [
      newDraftMember({
        name: '研发',
        host: 'codex',
        model_provider: 'openai',
        model: 'gpt-5-codex',
        reasoning_effort: 'high',
        policyCeiling: 'read-only',
        allowBrowser: true,
      }),
      newDraftMember({ name: '', host: 'codex' }),
    ];

    const body = buildCreateGroupBody(form);
    expect(body.lead).toEqual({ name: '主 Agent', host: 'dsh' });
    expect(body.policy).toBe('workspace-write');
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toEqual({
      name: '研发',
      host: 'codex',
      selection: { model_provider: 'openai', model: 'gpt-5-codex', reasoning_effort: 'high' },
      policyCeiling: 'read-only',
      allowBrowser: true,
    });

    form.policy = 'communication';
    const strict = buildCreateGroupBody(form);
    expect(strict.allowShell).toBe(false);
    expect(strict.members[0].policyCeiling).toBeUndefined();
    expect(strict.members[0].allowBrowser).toBeUndefined();
  });

  it('快捷预设按可用宿主填行，研发 + 只读验收使用不同宿主', () => {
    const context = { defaultHost: 'dsh', availableHosts: ['dsh', 'codex'], groupPolicy: 'workspace-write' };
    expect(presetMembers('minimal', context).map((row) => row.name)).toEqual(['协作助手']);

    const review = presetMembers('dev-review', context);
    expect(review.map((row) => row.name)).toEqual(['研发', '只读验收']);
    expect(review[1].host).toBe('codex');
    expect(review[1].policyCeiling).toBe('read-only');

    const strict = presetMembers('dev-review', { ...context, groupPolicy: 'communication' });
    expect(strict[1].policyCeiling).toBe('');
  });

  it('旧草稿的单个 worker 迁移为一位协作成员，communication 清掉授权', () => {
    const restored = restoreDraft({
      operationId: 'old-op',
      name: '旧草稿',
      text: '需求',
      workspace: '/tmp/workspace',
      host: 'dsh',
      policy: 'communication',
      worker: '协作助手',
      submitted: false,
      group: null,
    });
    expect(restored.draft.lead.name).toBe('主 Agent');
    expect(restored.draft.members.map((row) => row.name)).toEqual(['协作助手']);
    expect(restored.draft.allowShell).toBe(false);
    expect(restored.draft.lead.allowBrowser).toBe(false);
  });
});

describe('CreateTeam 异构建群矩阵', () => {
  it('默认主 Agent + 协作助手，可添加多个协作成员并逐行删除', async () => {
    const wrapper = await mountCreateTeam();
    // 旧版默认组合保留:主 Agent + 一位协作助手。
    expect(wrapper.findAll('[data-testid^="member-row-"]')).toHaveLength(2);

    await wrapper.find('[data-testid="add-member"]').trigger('click');
    await wrapper.find('[data-testid="add-member"]').trigger('click');
    expect(wrapper.findAll('[data-testid^="member-row-"]')).toHaveLength(4);
    expect(wrapper.text()).toContain('4 位成员');

    await wrapper.find('[data-testid="remove-member-1"]').trigger('click');
    expect(wrapper.findAll('[data-testid^="member-row-"]')).toHaveLength(3);
    expect(wrapper.find('[data-testid="member-row-3"]').exists()).toBe(false);
  });

  it('成员行独立宿主与模型，确认卡汇总后按完整矩阵提交', async () => {
    const wrapper = await mountCreateTeam();
    await fillBasics(wrapper);
    await selectDefaultHost(wrapper, 'dsh');

    const memberRow = wrapper.find('[data-testid="member-row-1"]');
    await memberRow.find('input').setValue('研发');
    await chooseOption(wrapper, 'member-host-1', 'codex');
    await wrapper.find('[data-testid="member-row-1"] [data-testid="pick-model"]').trigger('click');
    await nextTick();
    // 允许浏览器授权应与模型/宿主一起进入确认卡与提交体。
    await wrapper.find('[data-testid="member-browser-1"]').trigger('click');
    await nextTick();
    expect(wrapper.find('[data-testid="member-browser-1"]').attributes('data-state')).toBe('checked');

    await clickSubmit(wrapper);
    const confirm = wrapper.find('[data-testid="create-team-confirm"]');
    expect(confirm.exists()).toBe(true);
    const summaries = confirm.findAll('[data-testid="member-summary"]');
    expect(summaries).toHaveLength(2);
    expect(summaries[0].text()).toContain('主 Agent');
    expect(summaries[0].text()).toContain('DSH');
    expect(summaries[0].text()).toContain('宿主默认');
    expect(summaries[1].text()).toContain('研发');
    expect(summaries[1].text()).toContain('Codex');
    expect(summaries[1].text()).toContain('GPT-5 Codex');
    expect(summaries[1].text()).toContain('允许修改工作文件夹');
    expect(summaries[1].text()).toContain('浏览器：允许');

    await buttonByText(wrapper, '确认创建').trigger('click');
    await settle();

    expect(mocks.createGroup).toHaveBeenCalledTimes(1);
    const body = mocks.createGroup.mock.calls[0][0];
    expect(body.name).toBe('异构团队');
    expect(body.workspace).toBe('/tmp/workspace');
    expect(body.policy).toBe('workspace-write');
    expect(body.allowShell).toBe(true);
    expect(body.lead).toEqual({ name: '主 Agent', host: 'dsh' });
    expect(body.members).toEqual([{
      name: '研发',
      host: 'codex',
      selection: { model_provider: 'openai', model: 'gpt-5-codex', reasoning_effort: 'high' },
      allowBrowser: true,
    }]);
    expect(mocks.sendTeamDirective).toHaveBeenCalledWith(GROUP.id, {
      operationId: body.operationId + '-first',
      text: '把接口拆开实现',
      controllerId: GROUP.lead,
    });
    expect(mocks.push).toHaveBeenCalledWith({ name: 'group', params: { groupId: GROUP.id } });
  });

  it('群策略向下调严时收敛成员上限与浏览器授权，并退出确认态', async () => {
    const wrapper = await mountCreateTeam();
    await fillBasics(wrapper);
    await selectDefaultHost(wrapper, 'dsh');

    await wrapper.find('[data-testid="member-row-1"] input').setValue('只读验收');
    await chooseOption(wrapper, 'member-ceiling-1', 'read-only');
    await wrapper.find('[data-testid="member-browser-1"]').trigger('click');
    await nextTick();
    expect(wrapper.find('[data-testid="member-browser-1"]').attributes('data-state')).toBe('checked');

    await clickSubmit(wrapper);
    expect(wrapper.find('[data-testid="create-team-confirm"]').exists()).toBe(true);

    await chooseOption(wrapper, 'group-policy', 'communication');
    await settle();

    // 确认摘要按旧权限展示过,任何字段变化都必须退出确认态。
    expect(wrapper.find('[data-testid="create-team-confirm"]').exists()).toBe(false);
    const notice = wrapper.find('[data-testid="policy-notice"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain('1 个成员');
    const browserSwitch = wrapper.find('[data-testid="member-browser-1"]');
    expect(browserSwitch.attributes('data-state')).toBe('unchecked');
    expect(browserSwitch.attributes()).toHaveProperty('disabled');

    await confirmCreate(wrapper);
    const body = mocks.createGroup.mock.calls[0][0];
    expect(body.policy).toBe('communication');
    expect(body.allowShell).toBe(false);
    expect(body.members).toHaveLength(1);
    expect(body.members[0].policyCeiling).toBeUndefined();
    expect(body.members[0].allowBrowser).toBeUndefined();
  });

  it('快捷预设自动填入研发 + 只读验收双人组', async () => {
    const wrapper = await mountCreateTeam();
    await fillBasics(wrapper);
    await selectDefaultHost(wrapper, 'dsh');

    await buttonByText(wrapper, '研发 + 只读验收双人组').trigger('click');
    await nextTick();
    expect(wrapper.findAll('[data-testid^="member-row-"]')).toHaveLength(3);
    const rows = wrapper.findAll('[data-testid^="member-row-"]');
    expect((rows[1].find('input').element as HTMLInputElement).value).toBe('研发');
    // 父组件把 data-testid=member-model-N 透传到替身根节点,宿主信息也在根节点上。
    expect(rows[2].find('[data-testid="member-model-2"]').attributes('data-host')).toBe('codex');

    await confirmCreate(wrapper);
    const body = mocks.createGroup.mock.calls[0][0];
    expect(body.members.map((member: { name: string }) => member.name)).toEqual(['研发', '只读验收']);
    expect(body.members[0].host).toBe('dsh');
    expect(body.members[1].host).toBe('codex');
    expect(body.members[1].policyCeiling).toBe('read-only');
  });

  it('确认态在字段改动后失效，需要重新确认', async () => {
    const wrapper = await mountCreateTeam();
    await fillBasics(wrapper);
    await selectDefaultHost(wrapper, 'dsh');

    await clickSubmit(wrapper);
    expect(wrapper.find('[data-testid="create-team-confirm"]').exists()).toBe(true);

    await chooseOption(wrapper, 'group-policy', 'read-only');
    await settle();
    expect(wrapper.find('[data-testid="member-ceiling-0"]').text()).toContain('继承群策略（只读）');

    await wrapper.find('#team-name').setValue('异构团队（改）');
    await nextTick();
    expect(wrapper.find('[data-testid="create-team-confirm"]').exists()).toBe(false);
  });

  it('套用工作流模板会填入成员与 charter 引导，按成员开启 worktree 并在仅沟通下关闭', async () => {
    const wrapper = await mountCreateTeam();
    await fillBasics(wrapper);
    await selectDefaultHost(wrapper, 'dsh');

    await chooseOption(wrapper, 'workflow-template', 'standard-dev');
    await settle();
    expect((wrapper.find('#team-charter').element as HTMLTextAreaElement).value).toContain('大文档路径交付');
    // 标准研发模板预设：研发（开启 worktree） + 只读验收（继承共享主工作区）
    expect(wrapper.find('[data-testid="member-worktree-1"]').attributes('data-state')).toBe('checked');
    expect(wrapper.find('[data-testid="member-worktree-2"]').attributes('data-state')).toBe('unchecked');

    // 用户手改 charter 后再切模板，保留用户手写文本。
    await wrapper.find('#team-charter').setValue('自定义团队准则');
    await chooseOption(wrapper, 'workflow-template', 'quick-fix');
    await settle();
    expect((wrapper.find('#team-charter').element as HTMLTextAreaElement).value).toBe('自定义团队准则');

    // 切回 standard-dev 并确认提交：携带 workflowTemplate、charter 与 worktree 成员。
    await chooseOption(wrapper, 'workflow-template', 'standard-dev');
    await settle();
    await confirmCreate(wrapper);
    const body = mocks.createGroup.mock.calls[0][0];
    expect(body.workflowTemplate).toBe('standard-dev');
    expect(body.charter).toBe('自定义团队准则');
    expect(body.members[0].workspaceMode).toBe('worktree');
    expect(body.members[1].workspaceMode).toBeUndefined();
    expect(body.lead.workspaceMode).toBeUndefined();
  });

  it('全局切到 communication 时重置协作成员 worktree 并禁用开关', async () => {
    const wrapper = await mountCreateTeam();
    await fillBasics(wrapper);
    await selectDefaultHost(wrapper, 'dsh');
    await wrapper.find('[data-testid="member-worktree-1"]').trigger('click');
    await nextTick();
    expect(wrapper.find('[data-testid="member-worktree-1"]').attributes('data-state')).toBe('checked');

    await chooseOption(wrapper, 'group-policy', 'communication');
    await settle();
    const wtSwitch = wrapper.find('[data-testid="member-worktree-1"]');
    expect(wtSwitch.attributes('data-state')).toBe('unchecked');
    expect(wtSwitch.attributes()).toHaveProperty('disabled');
  });
});