import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import MessageFeed from '@/features/messages/MessageFeed.vue';
import type { MessageView } from '@/shared/models/view-types';
import type { Interaction, InteractionPayload, TeamDirectiveReceipt } from '@/shared/api/raw-types';

vi.mock('@/components/ai-elements/ConversationScroller.vue', () => ({
  default: defineComponent({
    setup: (_props, { slots }) => () => h('div', [
      slots['bar-top']?.(),
      slots.default?.(),
      h('div', { 'data-sticky-bottom': true }, slots['bar-bottom']?.()),
    ]),
  }),
}));
vi.mock('@/components/ai-elements/RunStatusCard.vue', () => ({
  default: defineComponent({
    setup: () => () => h('aside', { 'data-testid': 'run-status-card' }, '成员运行状态'),
  }),
}));
vi.mock('@/components/ai-elements/MessageTrace.vue', () => ({
  default: defineComponent({ setup: () => () => h('div') }),
}));
vi.mock('@/components/ai-elements/ConversationOutline.vue', () => ({
  default: defineComponent({ setup: () => () => h('nav') }),
}));
vi.mock('@/components/ai-elements/MarkdownRenderer.vue', () => ({
  default: defineComponent({
    props: { content: { type: String, default: '' } },
    setup: (props) => () => h('p', props.content),
  }),
}));

function makeMessage(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: 'm1',
    seq: 1,
    pairKey: 'user:agent',
    senderName: '用户',
    recipientName: 'Panel Agent',
    senderIsLead: false,
    senderIsUser: false,
    kind: 'send',
    text: '你好',
    createdAt: '2026-11-05T00:00:00.000Z',
    turnId: null,
    ...overrides,
  };
}

function makeInteraction(payload: InteractionPayload): Interaction {
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
  };
}

const receipt: TeamDirectiveReceipt = {
  operationId: 'op',
  messageId: 'm1',
  seq: 1,
  recipient: 'Panel Agent',
  created: '2026-11-05T00:00:01.000Z',
  status: 'delivered',
  error: null,
};

async function renderFeed(props: Record<string, unknown>, slots?: Record<string, () => unknown>) {
  const Feed = MessageFeed as unknown as Component;
  const app = createSSRApp({
    render: () => h(Feed, props, slots),
  });
  app.use(VueQueryPlugin, { queryClient: new QueryClient() });
  return renderToString(app);
}

const occurrences = (html: string, needle: string) => html.split(needle).length - 1;

describe('conversation bottom bar', () => {
  it('places run status before the composer in the same bottom bar', async () => {
    const html = await renderFeed(
      { messages: [], selectedPair: '' },
      { 'bar-bottom': () => h('textarea', { 'aria-label': '消息输入框' }) },
    );
    const bar = html.indexOf('data-sticky-bottom');
    const status = html.indexOf('data-testid="run-status-card"');
    const composer = html.indexOf('aria-label="消息输入框"');
    expect(status).toBeGreaterThan(bar);
    expect(composer).toBeGreaterThan(status);
    expect(html.match(/data-testid="run-status-card"/g)).toHaveLength(1);
  });
});

describe('message receipt placement', () => {
  it('用户的发言把回执放在右侧,与气泡同一侧', async () => {
    const html = await renderFeed({
      messages: [makeMessage({ senderIsUser: true, kind: 'send' })],
      directives: [receipt],
    });

    expect(html).toContain('message-receipt--end');
  });

  it('其他人的发言把回执放在左侧', async () => {
    const html = await renderFeed({
      messages: [makeMessage({ kind: 'system' })],
      directives: [receipt],
    });

    expect(html).toContain('class="message-receipt"');
    expect(html).not.toContain('message-receipt--end');
  });
});

describe('interaction card as the only surface', () => {
  const leadMessage = (overrides: Partial<MessageView> = {}) => makeMessage({
    senderName: 'Lead',
    recipientName: '用户',
    senderIsLead: true,
    text: '请求将成员 甲 的模型调整为 test',
    createdAt: '2026-11-06T07:43:38.000Z',
    turnId: 'turn-1',
    ...overrides,
  });

  it('cardOnly 锚点不渲染消息气泡,正文只由卡片出现一次', async () => {
    const payload: InteractionPayload = {
      kind: 'member_model',
      text: '请求将成员 甲 的模型调整为 test',
      cardOnly: true,
    };
    const html = await renderFeed({
      messages: [leadMessage()],
      interactions: [makeInteraction(payload)],
      selectedPair: '',
    });

    expect(occurrences(html, '请求将成员 甲 的模型调整为 test')).toBe(1);
    expect(html).toContain('data-testid="interaction-card"');
    expect(html).toMatch(/Lead · \d{2}:\d{2}:\d{2}/);
  });

  it('没有 cardOnly 的老数据保持原样:气泡与卡片各有一份正文', async () => {
    const payload: InteractionPayload = { kind: 'member_model', text: '请求将成员 甲 的模型调整为 test' };
    const html = await renderFeed({
      messages: [leadMessage()],
      interactions: [makeInteraction(payload)],
      selectedPair: '',
    });

    expect(occurrences(html, '请求将成员 甲 的模型调整为 test')).toBe(2);
  });

  it('多步卡片一次只显示一题,打开时停在第 2 题并给出前进后退', async () => {
    const payload: InteractionPayload = {
      kind: 'flow',
      text: '上线前确认',
      cardOnly: true,
      steps: [
        { kind: 'choice', text: '是否切换流量？', options: ['切换', '暂不'], answer: { selected: '切换' } },
        { kind: 'choice', text: '回滚窗口？', options: ['十分钟', '半小时'], answer: null },
        { kind: 'input', text: '灰度比例？', answer: null },
      ],
    };
    const html = await renderFeed({
      messages: [leadMessage({ text: '上线前确认' })],
      interactions: [makeInteraction(payload)],
      selectedPair: '',
    });

    expect(html).toContain('第 2 / 3 题');
    expect(html).toContain('回滚窗口？');
    expect(html).toContain('十分钟');
    expect(html).not.toContain('是否切换流量');
    expect(html).not.toContain('灰度比例');
    expect(html).toContain('上一题');
    expect(html).toContain('下一题');
    expect(html).not.toContain('提交全部');
    expect(html.match(/查看第 \d 题/g)?.length).toBe(3);
  });

  it('已答复的多步卡片平铺问答,不再出任何交互控件', async () => {
    const payload: InteractionPayload = {
      kind: 'flow',
      text: '上线前确认',
      cardOnly: true,
      steps: [
        { kind: 'choice', text: '是否切换流量？', options: ['切换', '暂不'], answer: { selected: '切换' } },
        { kind: 'input', text: '灰度比例？', answer: { value: '10%' } },
      ],
    };
    const answered: Interaction = {
      ...makeInteraction(payload),
      state: 'answered',
      answer: { answers: [{ selected: '切换' }, { value: '10%' }] },
    };
    const html = await renderFeed({
      messages: [leadMessage({ text: '上线前确认' })],
      interactions: [answered],
      selectedPair: '',
    });

    expect(html).toContain('是否切换流量？');
    expect(html).toContain('切换');
    expect(html).toContain('灰度比例？');
    expect(html).toContain('10%');
    expect(html).not.toContain('第 1 / 2 题');
    expect(html).not.toContain('下一题');
    expect(html).not.toContain('上一题');
    expect(html).not.toContain('提交全部');
    expect(html).not.toContain('暂不');
  });

  it('单问卡的答复与多步卡共用同一套记录样式', async () => {
    const payload: InteractionPayload = { kind: 'input', text: '用一句话写下你对团队的期待。', cardOnly: true };
    const answered: Interaction = {
      ...makeInteraction(payload),
      state: 'answered',
      answer: { value: '123' },
    };
    const html = await renderFeed({
      messages: [leadMessage({ text: '用一句话写下你对团队的期待。' })],
      interactions: [answered],
      selectedPair: '',
    });

    expect(html).toContain('用一句话写下你对团队的期待。');
    expect(html).toContain('123');
    expect(html).toContain('border-l border-border pl-2');
    expect(html).not.toContain('data-slot="badge"');
  });
});
