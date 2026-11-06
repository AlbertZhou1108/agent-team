// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { VueQueryPlugin } from '@tanstack/vue-query';
import InteractionCard from './InteractionCard.vue';
import type { Interaction, InteractionPayload } from '@/shared/api/raw-types';

// 行为级测试只关心「点了什么 → 发往哪个公共入口的什么参数」，API 与 toast 全部替身，
// 不依赖真实网络或宿主。
const answerInteraction = vi.hoisted(() => vi.fn(async (_id: string, _answer: unknown) => ({})));
vi.mock('@/shared/api/client', () => ({ api: { answerInteraction } }));
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function makeInteraction(
  payload: InteractionPayload,
  overrides: Partial<Interaction> = {},
): Interaction {
  return {
    id: 'i1',
    group_id: 'g1',
    member_id: 'member-1',
    panel_agent_id: null,
    endpoint_id: 'endpoint-1',
    context: 'coordination',
    turn_id: 'turn-1',
    call_id: 'call-1',
    message_id: 'm1',
    panel_message_id: null,
    kind: payload.kind,
    payload,
    state: 'pending',
    answer: null,
    detail: null,
    answer_message_id: null,
    created: '2026-11-06T07:43:38.500Z',
    answered: null,
    ...overrides,
  };
}

function mountCard(payload: InteractionPayload, overrides: Partial<Interaction> = {}) {
  return mount(InteractionCard, {
    props: { interaction: makeInteraction(payload, overrides) },
    global: { plugins: [VueQueryPlugin] },
  });
}

function buttonByText(wrapper: ReturnType<typeof mountCard>, text: string) {
  const button = wrapper.findAll('button').find((item) => item.text().trim() === text);
  if (!button) throw new Error(`找不到按钮：${text}`);
  return button;
}

beforeEach(() => {
  answerInteraction.mockClear();
});

describe('InteractionCard 作答', () => {
  it('选择题点选项即提交 selected 答复', async () => {
    const wrapper = mountCard({ kind: 'choice', text: '选一个方案', options: ['方案甲', '方案乙'] });

    await buttonByText(wrapper, '方案甲').trigger('click');
    await flushPromises();

    expect(answerInteraction).toHaveBeenCalledTimes(1);
    expect(answerInteraction).toHaveBeenCalledWith('i1', { selected: '方案甲' });
  });

  it('填写题提交去空白后的文本；空内容只提示不发请求', async () => {
    const wrapper = mountCard({ kind: 'input', text: '用一句话写下期待' });

    await buttonByText(wrapper, '提交答复').trigger('click');
    await flushPromises();
    expect(answerInteraction).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('请填写内容后再提交');

    await wrapper.find('textarea').setValue('  团队协作更顺  ');
    await buttonByText(wrapper, '提交答复').trigger('click');
    await flushPromises();

    expect(answerInteraction).toHaveBeenCalledWith('i1', { value: '团队协作更顺' });
    expect(wrapper.text()).not.toContain('请填写内容后再提交');
  });

  it('接管/交还类动作提交同意或拒绝', async () => {
    const wrapper = mountCard({ kind: 'takeover', text: '请求接管当前回合' });

    await buttonByText(wrapper, '同意').trigger('click');
    await flushPromises();
    expect(answerInteraction).toHaveBeenLastCalledWith('i1', { approved: true });

    await buttonByText(wrapper, '拒绝').trigger('click');
    await flushPromises();
    expect(answerInteraction).toHaveBeenLastCalledWith('i1', { approved: false });
  });
});

describe('InteractionCard 多步 flow', () => {
  const flowPayload: InteractionPayload = {
    kind: 'flow',
    text: '上线前确认',
    steps: [
      { kind: 'choice', text: '是否切换流量？', options: ['切换', '暂不'], answer: null },
      { kind: 'input', text: '灰度比例？', answer: null },
    ],
  };

  it('一次只显示一题，选择题答完自动进下一题，整卡提交全部答案', async () => {
    const wrapper = mountCard(flowPayload);

    expect(wrapper.text()).toContain('第 1 / 2 题');
    expect(wrapper.text()).toContain('是否切换流量？');
    expect(wrapper.text()).not.toContain('灰度比例？');

    // 选择题点完用动效时长延时切题（motionDurationMs('normal') = 220ms）。
    await buttonByText(wrapper, '切换').trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 260));
    await flushPromises();

    expect(wrapper.text()).toContain('第 2 / 2 题');
    expect(wrapper.text()).toContain('灰度比例？');
    expect(wrapper.text()).not.toContain('是否切换流量？');

    await wrapper.find('textarea').setValue('10%');
    await buttonByText(wrapper, '提交全部').trigger('click');
    await flushPromises();

    expect(answerInteraction).toHaveBeenCalledTimes(1);
    expect(answerInteraction).toHaveBeenCalledWith('i1', {
      answers: [{ selected: '切换' }, { value: '10%' }],
    });
  });

  it('有未答题时整卡提交跳到该题并提示，不做半套投递', async () => {
    const wrapper = mountCard(flowPayload);

    await buttonByText(wrapper, '下一题').trigger('click');
    await buttonByText(wrapper, '提交全部').trigger('click');
    await flushPromises();

    expect(answerInteraction).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('第 1 题还没回答');
    // 跳回第一题，让用户直接看到缺的那一题。
    expect(wrapper.text()).toContain('是否切换流量？');
    expect(wrapper.text()).not.toContain('灰度比例？');
  });
});

describe('InteractionCard 非待答状态', () => {
  it('已取消的卡片展示「已取消」且不再提供作答控件', () => {
    const wrapper = mountCard(
      { kind: 'choice', text: '要不要继续', options: ['继续', '停止'] },
      { state: 'cancelled' },
    );

    expect(wrapper.text()).toContain('已取消');
    // 选项按钮与输入框都不存在：取消后不再提供任何作答入口。
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(wrapper.find('textarea').exists()).toBe(false);
  });

  it('已答复的填写题平铺问题与答案，不显示输入框', () => {
    const wrapper = mountCard(
      { kind: 'input', text: '对团队的期待' },
      { state: 'answered', answer: { value: '更顺的协作' } },
    );

    expect(wrapper.text()).toContain('对团队的期待');
    expect(wrapper.text()).toContain('更顺的协作');
    expect(wrapper.find('textarea').exists()).toBe(false);
  });
});
