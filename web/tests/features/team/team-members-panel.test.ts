// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { CapabilityCard, Member } from '@/shared/api/raw-types';
import TeamMembersPanel from '@/features/team/TeamMembersPanel.vue';

// 成员面板的行为级测试：能力徽标只读副本、调整权限弹窗的选项/禁用/提交矩阵，
// API 与成员用量查询全部替身，断言「看到什么 → 提交了什么」。
const mocks = vi.hoisted(() => ({
  updateMemberPolicy: vi.fn(),
  teamWorktrees: vi.fn(),
  mergeMemberWorktree: vi.fn(),
  removeMemberWorktree: vi.fn(),
}));

vi.mock('@/shared/api/client', () => ({
  api: {
    updateMemberPolicy: mocks.updateMemberPolicy,
    teamWorktrees: mocks.teamWorktrees,
    mergeMemberWorktree: mocks.mergeMemberWorktree,
    removeMemberWorktree: mocks.removeMemberWorktree,
  },
}));

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/features/queries', async () => {
  const { ref } = await import('vue');
  return { useMembersTelemetryQuery: () => ({ data: ref(undefined) }) };
});

// reka Select 在 happy-dom 下不便展开，替身为「点击带 data-value 的选项按钮即更新 v-model」。
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

function card(over: Partial<CapabilityCard> = {}): CapabilityCard {
  return {
    memberId: 'm1',
    model: {
      id: 'gpt-5-codex',
      provider: 'openai',
      label: 'GPT-5 Codex',
      knownInCatalog: true,
      inputModalities: ['text'],
      contextWindow: 200000,
      reasoningEffort: 'high',
      reasoningEfforts: ['high'],
    },
    modelSummary: { host: 'codex', provider: 'openai', model: 'gpt-5-codex', label: 'GPT-5 Codex', knownInCatalog: true },
    effectivePolicy: { ceiling: 'workspace-write', mode: 'workspace-write', reason: null, browserReason: null },
    effectiveCapabilities: {
      'exec.read': true,
      'exec.write': true,
      'exec.shell': true,
      'modal.image': true,
      'tool.browser': true,
    },
    ...over,
  };
}

function member(over: Partial<Member> = {}): Member {
  return {
    id: 'm1',
    group_id: 'g1',
    name: '研发',
    host: 'codex',
    role: 'member',
    profile: '',
    removed: null,
    model_provider: 'openai',
    model: 'gpt-5-codex',
    reasoning_effort: 'high',
    policy_ceiling: null,
    allow_shell: null,
    allow_browser: 0,
    capabilityCard: card(),
    ...over,
  };
}

async function settle() {
  await flushPromises();
  await nextTick();
  await flushPromises();
}

function mountPanel(over: {
  members?: Member[];
  runningMemberIds?: Set<string>;
  groupPolicy?: string | null;
  groupAllowShell?: boolean;
} = {}) {
  return mount(TeamMembersPanel, {
    attachTo: document.body,
    props: {
      groupId: 'g1',
      members: over.members ?? [member()],
      endpoints: [],
      runningMemberIds: over.runningMemberIds ?? new Set<string>(),
      groupPolicy: over.groupPolicy === undefined ? 'workspace-write' : over.groupPolicy,
      groupAllowShell: over.groupAllowShell === undefined ? true : over.groupAllowShell,
    },
  });
}

function buttonByText(text: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  if (!button) throw new Error('找不到按钮：' + text);
  return button as HTMLButtonElement;
}

function dialogEl(testId: string) {
  return document.querySelector('[data-testid="' + testId + '"]') as HTMLElement | null;
}

async function openPolicyDialog(panel: ReturnType<typeof mountPanel>) {
  buttonByText('调整权限', panel.element).click();
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMemberPolicy.mockResolvedValue({ member: member() });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('成员能力徽标', () => {
  it('按 capabilityCard 展示生效策略、模态、浏览器与命令事实', () => {
    const wrapper = mountPanel();
    const row = wrapper.find('[data-testid="member-capabilities-m1"]');
    expect(row.text()).toContain('可写');
    expect(row.text()).toContain('多模态');
    expect(row.text()).toContain('浏览器可用');
    expect(row.text()).toContain('可执行命令');
    wrapper.unmount();
  });

  it('unknown 模态标为模态未知，浏览器禁用且命令不可执行时不虚构可用', () => {
    const wrapper = mountPanel({
      members: [member({
        capabilityCard: card({
          effectiveCapabilities: {
            'exec.read': true,
            'exec.write': true,
            'exec.shell': false,
            'modal.image': 'unknown',
            'tool.browser': false,
          },
        }),
      })],
    });
    const row = wrapper.find('[data-testid="member-capabilities-m1"]');
    expect(row.text()).toContain('模态未知');
    expect(row.text()).toContain('浏览器禁用');
    expect(row.text()).not.toContain('可执行命令');
    expect(row.text()).not.toContain('多模态');
    wrapper.unmount();
  });

  it('缺能力卡时只弱化展示请求上限，不推断生效档位', () => {
    const wrapper = mountPanel({
      members: [member({ capabilityCard: undefined, policy_ceiling: 'read-only' })],
    });
    const row = wrapper.find('[data-testid="member-capabilities-m1"]');
    expect(row.text()).toContain('能力未同步');
    expect(row.text()).toContain('上限：只读');
    expect(row.text()).not.toContain('多模态');
    expect(row.find('[data-capability="policy"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('缺能力卡且未设上限时显示继承群策略', () => {
    const wrapper = mountPanel({
      members: [member({ capabilityCard: undefined, policy_ceiling: null })],
    });
    expect(wrapper.find('[data-testid="member-capabilities-m1"]').text()).toContain('继承群策略');
    wrapper.unmount();
  });

  it('运行中禁用调整权限，保留调整模型与查看轨迹', () => {
    const wrapper = mountPanel({ runningMemberIds: new Set(['m1']) });
    expect(buttonByText('调整模型', wrapper.element).disabled).toBe(false);
    expect(buttonByText('查看轨迹', wrapper.element).disabled).toBe(true);
    const policyButton = buttonByText('调整权限', wrapper.element);
    expect(policyButton.disabled).toBe(true);
    expect(policyButton.title).toContain('运行中');
    expect(policyButton.getAttribute('aria-label')).toContain('运行中不可调整');
    wrapper.unmount();
  });

  it('首行仅放成员名与运行状态徽标，官方宿主名与角色标签落入独立元信息行', () => {
    const wrapper = mountPanel({
      members: [member({ id: 'm-lead', name: '主控-Codex桌面', host: 'codex-desktop', role: 'lead' })],
      runningMemberIds: new Set(['m-lead']),
    });
    const header = wrapper.get('[data-testid="member-card-header-m-lead"]');
    const meta = wrapper.get('[data-testid="member-card-meta-m-lead"]');
    expect(header.classes()).toContain('flex-nowrap');
    expect(header.text()).toContain('主控-Codex桌面');
    expect(header.text()).toContain('运行中');
    expect(header.text()).not.toContain('Codex 桌面应用');
    expect(meta.text()).toContain('Codex 桌面应用');
    expect(meta.text()).toContain('主 Agent');
    wrapper.unmount();
  });
});

describe('调整权限弹窗', () => {
  it('只列出群策略以内的上限档位并展示当前生效摘要', async () => {
    const wrapper = mountPanel({ groupPolicy: 'read-only' });
    await openPolicyDialog(wrapper);
    expect(document.body.textContent).toContain('调整权限 · 研发');
    expect(document.body.textContent).toContain('生效 可写');
    const ceiling = dialogEl('member-policy-ceiling');
    expect(ceiling).not.toBeNull();
    const values = [...ceiling!.querySelectorAll('button')].map(item => item.getAttribute('data-value'));
    expect(values).toContain('__inherit__');
    expect(values).toContain('communication');
    expect(values).toContain('read-only');
    expect(values).not.toContain('workspace-write');
    expect(document.body.textContent).toContain('调整权限或工具将清理该成员现有宿主会话');
    wrapper.unmount();
  });

  it('切换上限后保存只提交发生变化的三字段', async () => {
    const wrapper = mountPanel({ groupPolicy: 'workspace-write' });
    await openPolicyDialog(wrapper);
    const readOnly = [...dialogEl('member-policy-ceiling')!.querySelectorAll('button')]
      .find(item => item.getAttribute('data-value') === 'read-only') as HTMLButtonElement;
    readOnly.click();
    await settle();
    // 只读上限下命令开关被自动关闭并禁用，浏览器仍可授权。
    expect((dialogEl('member-policy-shell') as HTMLButtonElement).disabled).toBe(true);
    const browser = dialogEl('member-policy-browser') as HTMLButtonElement;
    expect(browser.disabled).toBe(false);
    browser.click();
    await settle();
    const saved = member({ policy_ceiling: 'read-only', allow_browser: 1 });
    mocks.updateMemberPolicy.mockResolvedValue({ member: saved });
    (dialogEl('member-policy-save') as HTMLButtonElement).click();
    await settle();
    expect(mocks.updateMemberPolicy).toHaveBeenCalledWith('g1', 'm1', {
      policyCeiling: 'read-only',
      allowBrowser: true,
    });
    expect(wrapper.emitted('member-policy-saved')?.[0]).toEqual([saved]);
    expect(dialogEl('member-policy-dialog')).toBeNull();
    wrapper.unmount();
  });

  it('继承群命令权限时开关默认开启，关闭与开启浏览器均提交布尔字段并关闭弹窗', async () => {
    const wrapper = mountPanel({ groupPolicy: 'workspace-write' });
    await openPolicyDialog(wrapper);
    const shell = dialogEl('member-policy-shell') as HTMLButtonElement;
    expect(shell.getAttribute('data-state')).toBe('checked');
    shell.click();
    await settle();
    expect((dialogEl('member-policy-shell') as HTMLElement).getAttribute('data-state')).toBe('unchecked');
    (dialogEl('member-policy-browser') as HTMLButtonElement).click();
    await settle();
    (dialogEl('member-policy-save') as HTMLButtonElement).click();
    await settle();
    expect(mocks.updateMemberPolicy).toHaveBeenCalledWith('g1', 'm1', {
      allowShell: false,
      allowBrowser: true,
    });
    expect(wrapper.emitted('member-policy-saved')).toBeTruthy();
    wrapper.unmount();
  });

  it('已显式关闭命令时开关默认关闭，可重新打开并提交 true', async () => {
    const wrapper = mountPanel({
      groupPolicy: 'workspace-write',
      members: [member({ allow_shell: 0 })],
    });
    await openPolicyDialog(wrapper);
    const shell = dialogEl('member-policy-shell') as HTMLButtonElement;
    expect(shell.getAttribute('data-state')).toBe('unchecked');
    shell.click();
    await settle();
    expect((dialogEl('member-policy-shell') as HTMLElement).getAttribute('data-state')).toBe('checked');
    (dialogEl('member-policy-save') as HTMLButtonElement).click();
    await settle();
    expect(mocks.updateMemberPolicy).toHaveBeenCalledWith('g1', 'm1', {
      allowShell: true,
    });
    wrapper.unmount();
  });

  it('保存失败时在弹窗内展示服务端错误并保留用户选择', async () => {
    const wrapper = mountPanel();
    mocks.updateMemberPolicy.mockRejectedValue(new Error('成员正在运行，不能调整权限'));
    await openPolicyDialog(wrapper);
    (dialogEl('member-policy-browser') as HTMLButtonElement).click();
    await settle();
    (dialogEl('member-policy-save') as HTMLButtonElement).click();
    await settle();
    expect(dialogEl('member-policy-error')?.textContent).toContain('成员正在运行，不能调整权限');
    expect(dialogEl('member-policy-dialog')).not.toBeNull();
    expect((dialogEl('member-policy-browser') as HTMLElement).getAttribute('data-state')).toBe('checked');
    expect(wrapper.emitted('member-policy-saved')).toBeUndefined();
    wrapper.unmount();
  });

  it('没有变更时保存按钮禁用并说明原因', async () => {
    const wrapper = mountPanel();
    await openPolicyDialog(wrapper);
    const save = dialogEl('member-policy-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('没有需要保存的变更');
    wrapper.unmount();
  });
});

describe('调整权限弹窗的防御性分支', () => {
  it('群策略未同步时只提供继承选项，不展示可能越级的档位', async () => {
    const wrapper = mountPanel({
      groupPolicy: null,
      members: [member({ policy_ceiling: 'workspace-write' })],
    });
    await openPolicyDialog(wrapper);
    const values = [...dialogEl('member-policy-ceiling')!.querySelectorAll('button')]
      .map(item => item.getAttribute('data-value'));
    expect(values).toEqual(['__inherit__']);
    wrapper.unmount();
  });

  it('群未允许执行命令时命令开关禁用并说明原因', async () => {
    const wrapper = mountPanel({ groupAllowShell: false });
    await openPolicyDialog(wrapper);
    expect((dialogEl('member-policy-shell') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('群策略未允许执行命令，成员级开关不会生效');
    wrapper.unmount();
  });

  it('保存中禁用弹窗控件，完成后恢复', async () => {
    let resolveSave: (value: { member: Member }) => void = () => {};
    mocks.updateMemberPolicy.mockReturnValue(new Promise((resolve) => {
      resolveSave = resolve;
    }));
    const wrapper = mountPanel();
    await openPolicyDialog(wrapper);
    (dialogEl('member-policy-browser') as HTMLButtonElement).click();
    await settle();
    (dialogEl('member-policy-save') as HTMLButtonElement).click();
    await settle();
    expect(dialogEl('member-policy-save')!.textContent).toContain('保存中');
    expect((dialogEl('member-policy-save') as HTMLButtonElement).disabled).toBe(true);
    expect((dialogEl('member-policy-browser') as HTMLButtonElement).disabled).toBe(true);
    resolveSave({ member: member({ allow_browser: 1 }) });
    await settle();
    expect(wrapper.emitted('member-policy-saved')).toBeTruthy();
    wrapper.unmount();
  });
});

describe('成员独立 worktree 面板与操作弹窗', () => {
  it('worktree 成员显示分支徽标并支持合入与保守保留二次强删', async () => {
    const wtMember = member({
      id: 'm-wt',
      name: '并发研发',
      workspace_mode: 'worktree',
      worktree_path: '/tmp/data/worktrees/g1/m-wt',
      worktree_branch: 'agent-team/g1-dev-mwt1',
    });
    mocks.teamWorktrees.mockResolvedValue([
      {
        memberId: 'm-wt',
        memberName: '并发研发',
        host: 'dsh',
        path: '/tmp/data/worktrees/g1/m-wt',
        branch: 'agent-team/g1-dev-mwt1',
        branchExists: true,
        exists: true,
        dirtyCount: 0,
        untrackedCount: 0,
        aheadCount: 1,
        headCommit: 'abc1234',
        baseCommit: '0001111',
        changedFiles: [],
        diffStat: ' src/a.ts | 3 +++',
        error: null,
      },
    ]);
    mocks.mergeMemberWorktree.mockResolvedValue({
      memberId: 'm-wt',
      memberName: '并发研发',
      merged: true,
      alreadyUpToDate: false,
      branch: 'agent-team/g1-dev-mwt1',
      commit: 'def5678',
    });
    mocks.removeMemberWorktree
      .mockResolvedValueOnce({
        memberId: 'm-wt',
        memberName: '并发研发',
        removed: false,
        retained: true,
        path: '/tmp/data/worktrees/g1/m-wt',
        branch: 'agent-team/g1-dev-mwt1',
        aheadCount: 1,
        reason: '成员 worktree 仍含1 个未合入提交，已保守保留现场',
      })
      .mockResolvedValueOnce({
        memberId: 'm-wt',
        memberName: '并发研发',
        removed: true,
        retained: false,
        path: '/tmp/data/worktrees/g1/m-wt',
        branch: 'agent-team/g1-dev-mwt1',
      });

    const wrapper = mountPanel({ members: [wtMember] });
    expect(wrapper.find('[data-capability="worktree"]').text()).toContain('g1-dev-mwt1');

    await wrapper.find('[data-testid="member-worktree-btn-m-wt"]').trigger('click');
    await settle();
    expect(dialogEl('member-worktree-dialog')).not.toBeNull();
    expect(document.body.textContent).toContain('未合入 1 提交');

    // 合入主工作区
    (dialogEl('worktree-merge-btn') as HTMLButtonElement).click();
    await settle();
    expect(mocks.mergeMemberWorktree).toHaveBeenCalledWith('g1', 'm-wt');

    // 先触发普通清理 → 保守保留警告；点击二次强制删除 → 传入 force=true。
    (dialogEl('worktree-remove-btn') as HTMLButtonElement).click();
    await settle();
    expect(dialogEl('worktree-retained-warning')).not.toBeNull();
    (dialogEl('worktree-force-remove') as HTMLButtonElement).click();
    await settle();
    expect(mocks.removeMemberWorktree).toHaveBeenNthCalledWith(2, 'g1', 'm-wt', true);
    wrapper.unmount();
  });
});
