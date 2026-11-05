import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import MessageFeed from './MessageFeed.vue';
import type { MessageView } from '@/shared/models/view-types';
import type { TeamDirectiveReceipt } from '@/shared/api/raw-types';

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

const receipt: TeamDirectiveReceipt = {
  operationId: 'op',
  messageId: 'm1',
  seq: 1,
  recipient: 'Panel Agent',
  created: '2026-11-05T00:00:01.000Z',
  status: 'delivered',
  error: null,
};

async function render(messages: MessageView[]) {
  // h() 对 SFC 的重载要求传 $props 全量;这里只关心渲染结果,按普通组件构造。
  const Feed = MessageFeed as unknown as Component;
  return renderToString(createSSRApp({
    render: () => h(Feed, { messages, directives: [receipt] }),
  }));
}

describe('message receipt placement', () => {
  it('用户的发言把回执放在右侧,与气泡同一侧', async () => {
    const html = await render([message({ senderIsUser: true, kind: 'send' })]);

    expect(html).toContain('message-receipt--end');
  });

  it('其他人的发言把回执放在左侧', async () => {
    const html = await render([message({ kind: 'system' })]);

    expect(html).toContain('class="message-receipt"');
    expect(html).not.toContain('message-receipt--end');
  });
});
