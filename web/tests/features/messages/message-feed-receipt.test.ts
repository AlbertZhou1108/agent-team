// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, type PropType } from 'vue';
import MessageFeed from '@/features/messages/MessageFeed.vue';
import type { MessageView } from '@/shared/models/view-types';

vi.mock('@/components/ai-elements/ConversationScroller.vue', () => ({
  default: defineComponent({
    setup: (_props, { slots }) => () =>
      h('div', [slots['bar-top']?.(), slots.default?.(), slots['bar-bottom']?.()]),
  }),
}));
vi.mock('@/components/ai-elements/RunStatusCard.vue', () => ({
  default: defineComponent({ setup: () => () => h('aside') }),
}));
vi.mock('@/components/ai-elements/ConversationOutline.vue', () => ({
  default: defineComponent({ setup: () => () => h('nav') }),
}));
vi.mock('@/components/ai-elements/MessageTrace.vue', () => ({
  default: defineComponent({ setup: () => () => h('div') }),
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
      h('div', { 'data-testid': 'agent-message' }, [
        h('span', props.message.text),
        slots.footer?.({ message: props.message }) ?? null,
      ]),
  }),
}));

const CONTROLLER_ID = 'f2259358-8ed7-4d46-838a-86afa38bf5d1';

const message: MessageView = {
  id: 'm1',
  seq: 1,
  pairKey: `user:${CONTROLLER_ID}`,
  senderName: '用户指令',
  recipientName: '主 Agent',
  senderIsLead: false,
  senderIsUser: true,
  kind: 'send',
  text: '修复后重试：请回复一句话确认收到',
  createdAt: new Date().toISOString(),
  turnId: null,
};

// 接口给的是接收者 id；名字要由消息流补齐，弹窗里不能出现 id。
function mountFeed() {
  return mount(MessageFeed, {
    props: {
      messages: [message],
      selectedPair: '',
      directives: [
        {
          operationId: 'op-1',
          messageId: 'm1',
          seq: 1,
          recipient: CONTROLLER_ID,
          created: new Date().toISOString(),
          status: 'failed',
          error: 'dsh 退出 (1)：QUOTA: Insufficient Balance',
        },
      ],
    },
    attachTo: document.body,
  });
}

// 弹窗 Teleport 到 body，所以读 body 而不是 wrapper。
const bodyText = () => document.body.textContent ?? '';

describe('回执 → 投递详情', () => {
  it('点失败标签能打开弹窗，并显示接收者名而不是 id', async () => {
    const wrapper = mountFeed();
    await flushPromises();

    await wrapper.get('.message-receipt-tag').trigger('click');
    await flushPromises();

    expect(bodyText()).toContain('投递失败');
    expect(bodyText()).toContain('发给「主 Agent」的消息没有送达');
    expect(bodyText()).not.toContain(CONTROLLER_ID);
    expect(bodyText()).toContain('复制报错');

    wrapper.unmount();
    document.body.innerHTML = '';
  });
});
