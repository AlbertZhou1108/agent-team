import { describe, it, expect, vi } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ConversationWorkspace from './ConversationWorkspace.vue';

vi.mock('@/components/ai-elements/ConversationFrame.vue', () => ({ default: defineComponent({ props: ['readonly'], setup: (props, { slots }) => () => h('section', [slots.default?.(), !props.readonly ? slots.composer?.() : null]) }) }));
vi.mock('./MessageFeed.vue', () => ({ default: defineComponent({ props: ['messages', 'groupSystemMessages', 'streamSource', 'markdown'], setup: (props, { slots }) => () => h('div', { 'data-grouped': String(props.groupSystemMessages), 'data-markdown': String(props.markdown) }, [slots.empty?.(), slots.footer?.({ message: props.messages[0] })]) }) }));

function render(readonly: boolean, stream: () => []) {
  return renderToString(createSSRApp({ render: () => h(ConversationWorkspace, { heading: '会话', messages: [{ id: 'one' }] as any, selectedPair: '', readonly, streamSource: stream }, { composer: () => h('textarea', { 'aria-label': '草稿' }), footer: ({ message }: any) => h('span', { 'data-receipt': message.id }, '回执'), actions: () => h('button', '模型设置') }) }));
}
describe('shared conversation surface', () => {
  it('preserves model controls and receipt slots while history becomes readonly', async () => {
    const stream = vi.fn(() => [] as []);
    const editable = await render(false, stream); const history = await render(true, stream);
    expect(editable).toContain('aria-label="草稿"'); expect(history).not.toContain('aria-label="草稿"');
    for (const html of [editable, history]) { expect(html).toContain('data-receipt="one"'); expect(html).toContain('模型设置'); }
    expect(stream).not.toHaveBeenCalled();
  });
  it('keeps team grouping enabled by default and allows Panel to override it', async () => {
    const team = await render(false, () => []);
    expect(team).toContain('data-grouped="true"');
    expect(team).toContain('data-markdown="true"');
    const html = await renderToString(createSSRApp({ render: () => h(ConversationWorkspace, { heading: 'Panel', messages: [], selectedPair: '', groupSystemMessages: false, error: '同步失败', retryable: true }) }));
    expect(html).toContain('data-grouped="false"'); expect(html).toContain('同步失败'); expect(html).toContain('重试');
  });
});
