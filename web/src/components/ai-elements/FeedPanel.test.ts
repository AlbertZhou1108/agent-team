import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import FeedPanel from './FeedPanel.vue';

// 这个包装组件只负责标题行、药丸类名与开合状态;内容归调用方,所以断言也
// 只覆盖这三件事 —— 数据加载、空态由各自的消费者测。
type PanelProps = {
  label: string;
  count?: number;
  countUnit?: string;
  align?: 'start' | 'end';
  defaultOpen?: boolean;
};

function render(props: PanelProps, slot: () => unknown = () => '内容') {
  return renderToString(createSSRApp({ render: () => h(FeedPanel, props, { default: slot }) }));
}

function triggerOf(html: string) {
  return html.match(/<button[^>]*data-slot="disclosure-trigger"[^>]*>(.*?)<\/button>/s)?.[1] ?? '';
}

describe('FeedPanel', () => {
  it('把标题与计数放进同一个触发条', async () => {
    const html = await render({ label: '系统通知', count: 3 });
    const trigger = triggerOf(html);
    expect(trigger).toContain('系统通知');
    expect(trigger).toContain('3 条');
    expect(html).toContain('内容');
  });

  it('没有计数时不渲染单位文案', async () => {
    const html = await render({ label: '执行轨迹' });
    expect(triggerOf(html)).toContain('执行轨迹');
    expect(html).not.toContain('条');
  });

  it('默认收起,defaultOpen 才展开', async () => {
    const closed = await render({ label: 'L' });
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('data-open="false"');

    const opened = await render({ label: 'L', defaultOpen: true });
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).toContain('data-open="true"');
  });

  it('始终带药丸类名,align=end 时再带上靠右修饰', async () => {
    const start = await render({ label: 'L' });
    expect(start).toContain('feed-panel');
    expect(start).not.toContain('feed-panel--end');

    const end = await render({ label: 'L', align: 'end' });
    expect(end).toContain('feed-panel--end');
  });

  it('把开合状态交给插槽,供消费者决定是否发请求', async () => {
    const html = await render({ label: 'L' }, () => h('span', 'idle'));
    expect(html).toContain('idle');

    const slotState = await renderToString(
      createSSRApp({
        render: () =>
          h(FeedPanel, { label: 'L' }, {
            default: ({ open }: { open: boolean }) => h('span', open ? 'expanded' : 'collapsed'),
          }),
      }),
    );
    expect(slotState).toContain('collapsed');
  });
});
