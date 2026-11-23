import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import { extractFilePathRefs } from '@/features/messages/file-refs';
import type { MessageView } from '@/shared/models/view-types';

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn(async () => {}) }),
}));

const longQuote = '收到回报原文：「第三轮回执汇报已完成。」还差面板状态确认：请将「第三轮回执汇报」标记为 done，然后用一条合并消息回复我。';

function messageWithQuote(): MessageView {
  return {
    id: 'message-1',
    seq: 783,
    pairKey: 'pair-1',
    senderName: '用户',
    recipientName: 'Panel Agent',
    senderIsLead: false,
    senderIsUser: true,
    kind: 'send',
    text: `> 引用消息 #780 · Panel Agent · ref-780\n> ${longQuote}\n\n告诉我，我引用了什么消息`,
    createdAt: '2026-11-05T14:24:35.000Z',
  };
}

describe('AgentMessage quote block', () => {
  it('wraps the quote instead of overflowing the bubble', async () => {
    // Button 的基类带 whitespace-nowrap/shrink-0;引用块必须覆盖,否则长引用被气泡裁掉右侧。
    const html = await renderToString(
      createSSRApp({ render: () => h(AgentMessage, { message: messageWithQuote() }) }),
    );
    const quoteButton = html.match(/<button[^>]*data-variant="outline"[^>]*>/)?.[0] ?? '';
    expect(quoteButton).toContain('whitespace-normal');
    expect(quoteButton).not.toContain('whitespace-nowrap');
    expect(quoteButton).toContain('shrink');
    expect(quoteButton).not.toMatch(/(?:^|\s)shrink-0(?:\s|$)/);
    expect(html).toContain('Panel Agent · #780');
  });

  it('extracts markdown/source file refs while skipping urls and parent traversal, and renders file ref chips', async () => {
    const sample = '已完成设计，详见 [spec.md](docs/flows/2026-11-23/spec.md#L12) 与 `web/src/App.vue`，忽略 https://example.com/a.md 与 ../secret.md。';
    expect(extractFilePathRefs(sample)).toEqual([
      'docs/flows/2026-11-23/spec.md#L12',
      'web/src/App.vue',
    ]);
    const html = await renderToString(
      createSSRApp({
        render: () => h(AgentMessage, {
          markdown: false,
          message: {
            ...messageWithQuote(),
            senderIsUser: false,
            text: sample,
          },
        }),
      }),
    );
    expect(html).toContain('data-testid="message-file-refs"');
    expect(html).toContain('spec.md');
    expect(html).toContain('App.vue');
  });
});
