// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref, type PropType } from 'vue';
import MessageFeed from './MessageFeed.vue';
import type { MessageView } from '@/shared/models/view-types';
import type { StreamView } from './adapters';

// 只替换重子组件：滚动容器/轨迹读取/运行卡与消息气泡都有各自的测试或外部依赖，
// 本文件聚焦 MessageFeed 自己的分组、流式追加与轨迹开合行为。
vi.mock('@/components/ai-elements/ConversationScroller.vue', () => ({
  default: defineComponent({
    setup: (_props, { slots }) => () =>
      h('div', { 'data-testid': 'scroller' }, [
        slots['bar-top']?.(),
        slots.default?.(),
        h('div', { 'data-sticky-bottom': true }, slots['bar-bottom']?.()),
      ]),
  }),
}));
vi.mock('@/components/ai-elements/RunStatusCard.vue', () => ({
  default: defineComponent({ setup: () => () => h('aside') }),
}));
vi.mock('@/components/ai-elements/ConversationOutline.vue', () => ({
  default: defineComponent({ setup: () => () => h('nav') }),
}));
vi.mock('@/components/ai-elements/AgentMessage.vue', () => ({
  default: defineComponent({
    props: {
      message: { type: Object as PropType<MessageView>, required: true },
      compact: Boolean,
      markdown: { type: Boolean, default: true },
      fanoutRecipients: { type: Array as PropType<string[]>, default: undefined },
    },
    setup: (props, { slots }) => () =>
      h('div', { 'data-testid': 'agent-message', 'data-message-id': props.message.id }, [
        h('span', props.message.text),
        slots['header-actions']?.({ message: props.message }) ?? null,
      ]),
  }),
}));
vi.mock('@/components/ai-elements/MessageTrace.vue', () => ({
  default: defineComponent({
    props: {
      messageId: { type: String, required: true },
      expanded: { type: Boolean, default: false },
      label: { type: String, default: undefined },
    },
    setup: (props) => () =>
      h('div', {
        'data-testid': 'message-trace',
        'data-message-id': props.messageId,
        'data-expanded': String(props.expanded),
      }),
  }),
}));

function message(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: 'm1',
    seq: 1,
    pairKey: 'user:agent',
    senderName: 'Lead',
    recipientName: '用户',
    senderIsLead: true,
    senderIsUser: false,
    kind: 'send',
    text: '已定稿消息',
    createdAt: '2026-11-06T07:43:38.000Z',
    turnId: null,
    ...overrides,
  };
}

function streaming(text: string): StreamView {
  return {
    message: message({ id: 'stream-1', seq: 0, text, kind: 'send', senderIsUser: false, turnId: 'turn-s' }),
    pending: true,
    turnId: 'turn-s',
  };
}

function renderFeed(
  messages: MessageView[],
  extra: { streamSource?: () => StreamView[]; traceable?: boolean } = {},
) {
  return mount(MessageFeed, {
    props: { messages, selectedPair: '', ...extra },
  });
}

describe('MessageFeed 流式追加', () => {
  it('流式正文按增量更新，已定稿消息不重排，计数随流式条目变化', async () => {
    const views = ref<StreamView[]>([]);
    const wrapper = renderFeed([message()], { streamSource: () => views.value });

    expect(wrapper.text()).toContain('1 条消息');
    expect(wrapper.text()).not.toContain('流式第一段');

    views.value = [streaming('流式第一段')];
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('2 条消息');
    expect(wrapper.text()).toContain('流式第一段');
    expect(wrapper.text()).toContain('已定稿消息');

    // 同一个流式消息的正文追加：只替换该条正文，不新增消息条目。
    views.value = [streaming('流式第一段，第二段')];
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('流式第一段，第二段');
    expect(wrapper.text()).not.toContain('流式第一段 ');
    expect(wrapper.text()).toContain('2 条消息');
  });
});

describe('MessageFeed 系统消息分组', () => {
  it('连续 system 消息折叠为一个通知堆栈并显示条数', () => {
    const wrapper = renderFeed([
      message({ id: 's1', seq: 1, kind: 'system', senderName: '系统', senderIsLead: false, text: '第一条通知' }),
      message({ id: 's2', seq: 2, kind: 'system', senderName: '系统', senderIsLead: false, text: '第二条通知' }),
      message({ id: 's3', seq: 3, kind: 'system', senderName: '系统', senderIsLead: false, text: '第三条通知' }),
    ]);

    const panels = wrapper.findAll('[data-slot="disclosure"]');
    expect(panels).toHaveLength(1);
    expect(wrapper.text()).toContain('系统通知');
    expect(wrapper.text()).toContain('3 条');
    // 折叠只改变展示形态，内容常驻 DOM，三条通知都还在。
    expect(wrapper.findAll('[data-testid="agent-message"]')).toHaveLength(3);
    // 系统通知没有回合轨迹入口。
    expect(wrapper.findAll('[data-testid="message-trace"]')).toHaveLength(0);
  });

  it('单条 system 消息独立渲染，不折叠成堆栈', () => {
    const wrapper = renderFeed([
      message({ id: 's1', seq: 1, kind: 'system', senderName: '系统', senderIsLead: false, text: '唯一通知' }),
    ]);

    expect(wrapper.findAll('[data-slot="disclosure"]')).toHaveLength(0);
    expect(wrapper.text()).toContain('唯一通知');
  });
});

describe('MessageFeed 执行轨迹折叠', () => {
  it('有回合来源的消息展示轨迹开关，点击在展开/收起之间切换', async () => {
    const wrapper = renderFeed([message({ turnId: 'turn-1' })]);
    const toggle = wrapper.get('[aria-label="消息 #1 的执行轨迹"]');

    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[data-testid="message-trace"]').attributes('data-expanded')).toBe('false');

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-testid="message-trace"]').attributes('data-expanded')).toBe('true');

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[data-testid="message-trace"]').attributes('data-expanded')).toBe('false');
  });

  it('traceable=false 或没有 turnId 的消息不提供轨迹入口', () => {
    const noTurn = renderFeed([message({ turnId: null })]);
    expect(noTurn.findAll('[data-testid="message-trace"]')).toHaveLength(0);
    expect(noTurn.find('[aria-label="消息 #1 的执行轨迹"]').exists()).toBe(false);

    const notTraceable = renderFeed([message({ turnId: 'turn-1' })], { traceable: false });
    expect(notTraceable.findAll('[data-testid="message-trace"]')).toHaveLength(0);
    expect(notTraceable.find('[aria-label="消息 #1 的执行轨迹"]').exists()).toBe(false);
  });
});
