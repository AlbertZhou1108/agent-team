// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { mount } from '@vue/test-utils';
import { renderToString } from 'vue/server-renderer';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import ExpandableText from '@/components/ai-elements/ExpandableText.vue';
import MarkdownRenderer from '@/components/ai-elements/MarkdownRenderer.vue';
import { stabilizeStreamingMarkdown } from '@/components/ai-elements/streaming-markdown';
import {
  filePreviewContext,
  normalizeFilePathRef,
  splitBareFileRefs,
  splitPlainTextFileRefs,
} from '@/features/messages/file-refs';
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

  it('renders inline file chips inside message text instead of a separate bottom chip strip', async () => {
    const sample = '已完成设计，详见 [spec.md](docs/flows/2026-11-23/spec.md#L12) 与 `web/src/App.vue`，或直接看 docs/notes.md，忽略 https://example.com/a.md 与 ../secret.md。';

    expect(normalizeFilePathRef('https://example.com/a.md')).toBeNull();
    expect(normalizeFilePathRef('../secret.md')).toBeNull();
    expect(normalizeFilePathRef('docs/flows/2026-11-23/spec.md#L12')).toBe(
      'docs/flows/2026-11-23/spec.md#L12',
    );
    expect(splitBareFileRefs('直接看 docs/notes.md 即可')).toEqual([
      { type: 'text', text: '直接看 ' },
      { type: 'file', label: 'notes.md', path: 'docs/notes.md' },
      { type: 'text', text: ' 即可' },
    ]);
    expect(splitPlainTextFileRefs('请阅读 [README.md](README.md) 与 `docs/notes.md`')).toEqual([
      { type: 'text', text: '请阅读 ' },
      { type: 'file', label: 'README.md', path: 'README.md' },
      { type: 'text', text: ' 与 ' },
      { type: 'file', label: 'notes.md', path: 'docs/notes.md' },
    ]);

    const plainApp = createSSRApp({
      provide: {
        [filePreviewContext as symbol]: { open: vi.fn() },
      },
      render: () =>
        h(AgentMessage, {
          markdown: false,
          message: {
            ...messageWithQuote(),
            senderIsUser: false,
            text: sample,
          },
        }),
    });
    const plainHtml = await renderToString(plainApp);
    expect(plainHtml).not.toContain('data-testid="message-file-refs"');
    expect(plainHtml).toContain('class="inline-file-chip"');
    expect(plainHtml).toContain('data-file-ref="docs/flows/2026-11-23/spec.md#L12"');
    expect(plainHtml).toContain('data-file-ref="web/src/App.vue"');
    expect(plainHtml).toContain('data-file-ref="docs/notes.md"');
    expect(plainHtml).not.toContain('data-file-ref="https://example.com/a.md"');
    expect(plainHtml).not.toContain('data-file-ref="../secret.md"');

    const onOpen = vi.fn();
    const mdWrapper = mount(MarkdownRenderer, {
      props: { content: sample },
      global: {
        provide: {
          [filePreviewContext as symbol]: { open: onOpen },
        },
      },
    });
    const mdHtml = mdWrapper.html();
    expect(mdHtml).toContain('class="inline-file-chip"');
    expect(mdHtml).toContain('data-file-ref="docs/flows/2026-11-23/spec.md#L12"');
    expect(mdHtml).toContain('data-file-ref="web/src/App.vue"');
    expect(mdHtml).toContain('data-file-ref="docs/notes.md"');
    expect(mdHtml).toContain('href="https://example.com/a.md"');

    await mdWrapper.get('button[data-file-ref="docs/notes.md"]').trigger('click');
    expect(onOpen).toHaveBeenCalledWith('docs/notes.md');
  });

  it('places secondary menu below the bubble and renders system notices as lightweight timeline events', async () => {
    const userHtml = await renderToString(
      createSSRApp({
        render: () =>
          h(
            AgentMessage,
            {
              message: {
                ...messageWithQuote(),
                text: '普通用户消息',
              },
            },
            {
              above: () => h('div', { 'data-testid': 'above-slot' }, '执行轨迹'),
              below: () => h('span', { 'data-testid': 'receipt-slot' }, '已投递'),
            },
          ),
      }),
    );
    const aboveIdx = userHtml.indexOf('data-testid="above-slot"');
    const bubbleIdx = userHtml.indexOf('data-slot="bubble"');
    const belowIdx = userHtml.indexOf('class="message-below');
    const menuIdx = userHtml.indexOf('消息 #783 的操作');
    const receiptIdx = userHtml.indexOf('data-testid="receipt-slot"');
    expect(aboveIdx).toBeGreaterThan(-1);
    expect(bubbleIdx).toBeGreaterThan(aboveIdx);
    expect(belowIdx).toBeGreaterThan(bubbleIdx);
    expect(menuIdx).toBeGreaterThan(belowIdx);
    expect(receiptIdx).toBeGreaterThan(menuIdx);

    const sysHtml = await renderToString(
      createSSRApp({
        render: () =>
          h(AgentMessage, {
            message: {
              ...messageWithQuote(),
              kind: 'system',
              senderIsUser: false,
              senderName: '系统',
              text: '已将成员分支安全合入主工作区',
            },
          }),
      }),
    );
    expect(sysHtml).toContain('data-testid="system-notice"');
    expect(sysHtml).toContain('data-tone="neutral"');
    expect(sysHtml).not.toContain('data-slot="bubble"');
    expect(sysHtml).not.toContain('>通知<');
  });

  it('stabilizes unclosed trailing markdown delimiters while streaming', () => {
    expect(stabilizeStreamingMarkdown('1. **')).toBe('1. ');
    expect(stabilizeStreamingMarkdown('**1. 实现位置')).toBe('**1. 实现位置**');
    expect(stabilizeStreamingMarkdown('**1. 实现位置**')).toBe('**1. 实现位置**');
    expect(stabilizeStreamingMarkdown('用 `foo')).toBe('用 `foo`');
    expect(stabilizeStreamingMarkdown('用 `')).toBe('用 ');
    expect(stabilizeStreamingMarkdown('```ts\nconst x = 1')).toBe('```ts\nconst x = 1\n```');
  });

  it('preserves expanded state on ExpandableText while streaming', async () => {
    const wrapper = mount(ExpandableText, {
      props: {
        text: 'line1\nline2',
        lines: 2,
        streaming: true,
      },
    });
    const vm = wrapper.vm as unknown as { expanded: boolean };
    vm.expanded = true;
    await wrapper.setProps({ text: 'line1\nline2\nline3' });
    expect(vm.expanded).toBe(true);

    await wrapper.setProps({ streaming: false, text: 'line1\nline2\nline3\nline4' });
    expect(vm.expanded).toBe(false);
    wrapper.unmount();
  });

  it('omits maxHeight clamp on ExpandableText while collapse animation is running', async () => {
    const wrapper = mount(ExpandableText, {
      props: { text: 'a\nb\nc\nd\ne\nf\ng', lines: 3 },
    });
    const vm = wrapper.vm as unknown as {
      expanded: boolean;
      animating: boolean;
      measuredLineHeight: number;
      bodyStyle: { maxHeight?: string } | undefined;
    };
    vm.measuredLineHeight = 20;
    vm.expanded = false;
    vm.animating = false;
    await wrapper.vm.$nextTick();
    expect(vm.bodyStyle).toEqual({ maxHeight: '60px' });

    vm.animating = true;
    await wrapper.vm.$nextTick();
    expect(vm.bodyStyle).toBeUndefined();
    wrapper.unmount();
  });
});
