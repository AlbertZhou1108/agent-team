import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import MessageFeed from './MessageFeed.vue';
import type { MessageView } from '@/shared/models/view-types';
import type { Interaction, InteractionPayload } from '@/shared/api/raw-types';

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
  default: defineComponent({ setup: () => () => h('aside') }),
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
    text: '请求将成员 甲 的模型调整为 test',
    createdAt: '2026-11-06T07:43:38.000Z',
    turnId: 'turn-1',
    ...overrides,
  };
}

function interaction(payload: InteractionPayload): Interaction {
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

async function render(messages: MessageView[], interactions: Interaction[]) {
  const Feed = MessageFeed as unknown as Component;
  const app = createSSRApp({
    render: () => h(Feed, { messages, interactions, selectedPair: '' }),
  });
  app.use(VueQueryPlugin, { queryClient: new QueryClient() });
  return renderToString(app);
}

const occurrences = (html: string, needle: string) => html.split(needle).length - 1;

describe('interaction card as the only surface', () => {
  it('cardOnly 锚点不渲染消息气泡,正文只由卡片出现一次', async () => {
    const payload: InteractionPayload = {
      kind: 'member_model',
      text: '请求将成员 甲 的模型调整为 test',
      cardOnly: true,
    };
    const html = await render([message()], [interaction(payload)]);

    // 同一段文本:卡片一次;气泡被隐藏,所以总数是一次。
    expect(occurrences(html, '请求将成员 甲 的模型调整为 test')).toBe(1);
    expect(html).toContain('data-testid="interaction-card"');
    // 气泡缺失后由卡片补回「谁 · 什么时候」。
    expect(html).toMatch(/Lead · \d{2}:\d{2}:\d{2}/);
  });

  it('没有 cardOnly 的老数据保持原样:气泡与卡片各有一份正文', async () => {
    const payload: InteractionPayload = { kind: 'member_model', text: '请求将成员 甲 的模型调整为 test' };
    const html = await render([message()], [interaction(payload)]);

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
    const html = await render([message({ text: '上线前确认' })], [interaction(payload)]);

    expect(html).toContain('第 2 / 3 题');
    // 只有当前题在屏上:前一题与后一题的正文都不渲染
    expect(html).toContain('回滚窗口？');
    expect(html).toContain('十分钟');
    expect(html).not.toContain('是否切换流量');
    expect(html).not.toContain('灰度比例');
    // 前进后退与进度点都在,提交按钮只在最后一题出现
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
      ...interaction(payload),
      state: 'answered',
      answer: { answers: [{ selected: '切换' }, { value: '10%' }] },
    };
    const html = await render([message({ text: '上线前确认' })], [answered]);

    // 问题与答案都在,但不分步骤、不留控件
    expect(html).toContain('是否切换流量？');
    expect(html).toContain('切换');
    expect(html).toContain('灰度比例？');
    expect(html).toContain('10%');
    expect(html).not.toContain('第 1 / 2 题');
    expect(html).not.toContain('下一题');
    expect(html).not.toContain('上一题');
    expect(html).not.toContain('提交全部');
    // 选项按钮不应再出现(只有一个已选答案)
    expect(html).not.toContain('暂不');
  });

  it('单问卡的答复与多步卡共用同一套记录样式', async () => {
    const payload: InteractionPayload = { kind: 'input', text: '用一句话写下你对团队的期待。', cardOnly: true };
    const answered: Interaction = {
      ...interaction(payload),
      state: 'answered',
      answer: { value: '123' },
    };
    const html = await render([message({ text: '用一句话写下你对团队的期待。' })], [answered]);

    expect(html).toContain('用一句话写下你对团队的期待。');
    expect(html).toContain('123');
    // 问题正文 + 答复左细边:与多步卡一致,不再是灰色药丸
    expect(html).toContain('border-l border-border pl-2');
    expect(html).not.toContain('data-slot="badge"');
  });
});
