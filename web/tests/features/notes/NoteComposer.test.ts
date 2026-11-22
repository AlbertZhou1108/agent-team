// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { createSSRApp, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { useUiStore } from '@/stores/ui';
import NoteComposer from '@/features/notes/NoteComposer.vue';

// 折叠只看取舍:收起态是单行输入框,展开态是多行文本;切换按钮始终嵌在文本框内。
function render() {
  const app = createSSRApp(NoteComposer, { submit: async () => {} });
  app.use(createPinia());
  return renderToString(app);
}

async function renderExpanded() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useUiStore().noteComposerCollapsed = false;
  const app = createSSRApp(NoteComposer, { submit: async () => {} });
  app.use(pinia);
  return renderToString(app);
}

function mountExpanded(pinia: Pinia = createPinia()) {
  setActivePinia(pinia);
  useUiStore().noteComposerCollapsed = false;
  return mount(NoteComposer, {
    props: { submit: async () => {} },
    global: { plugins: [pinia] },
  });
}

// 拖手柄:按指针移动的像素差调高,结果必须落在上下限之间。
function drag(handle: Element, fromY: number, toY: number) {
  handle.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientY: fromY, bubbles: true }));
  handle.dispatchEvent(new MouseEvent('pointermove', { clientY: toY, bubbles: true }));
  handle.dispatchEvent(new MouseEvent('pointerup', { clientY: toY, bubbles: true }));
}

function textareaHeight(wrapper: ReturnType<typeof mountExpanded>) {
  return (wrapper.get('textarea').element as HTMLTextAreaElement).style.height;
}

describe('NoteComposer', () => {
  // store 会从 localStorage 恢复,用例之间必须清干净,否则高度互相串。
  beforeEach(() => localStorage.clear());

  it('默认收起:单行输入框 + 框内的展开按钮,不给完整输入框占位', async () => {
    const html = await render();
    expect(html).toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).toContain('想到什么就写下来……');
    expect(html).toContain('aria-label="展开输入区"');
    expect(html).toContain('记下来');
  });

  it('展开后给出多行输入区、框内收起按钮与保存入口', async () => {
    const html = await renderExpanded();
    expect(html).toContain('<textarea');
    expect(html).not.toContain('aria-label="展开输入区"');
    expect(html).toContain('记一条想法');
    expect(html).toContain('记下来');
    expect(html).toContain('aria-label="收起输入区"');
  });

  it('展开态高度由右下角手柄拖动,超出上限就停住', async () => {
    const wrapper = mountExpanded();
    const handle = wrapper.get('[aria-label="调整输入区高度"]').element;
    const cap = Math.max(128, Math.min(360, Math.round(window.innerHeight * 0.45)));

    drag(handle, 200, 400);
    await nextTick();
    expect(textareaHeight(wrapper)).toBe('328px');

    // 一路往下拖也不越过封顶值:长笔记只让框内滚动,不把页面顶开。
    drag(handle, 200, 5000);
    await nextTick();
    expect(textareaHeight(wrapper)).toBe(`${cap}px`);

    // 往回拖到顶也不低于下限。
    drag(handle, 200, -5000);
    await nextTick();
    expect(textareaHeight(wrapper)).toBe('128px');
  });

  it('拖出来的高度写进 localStorage,重开页面还是同一个高度', async () => {
    const first = mountExpanded();
    drag(first.get('[aria-label="调整输入区高度"]').element, 200, 400);
    await nextTick();
    expect(textareaHeight(first)).toBe('328px');
    first.unmount();

    // 换一个全新 pinia = 重新打开页面:只能从 localStorage 读回来。
    const reopened = createPinia();
    const second = mountExpanded(reopened);
    expect(textareaHeight(second)).toBe('328px');
  });

  it('存下来的高度超过当前视口上限时,按上限显示', async () => {
    localStorage.setItem('agent-team:ui', JSON.stringify({ noteComposerHeight: 2000 }));
    const wrapper = mountExpanded();
    const cap = Math.max(128, Math.min(360, Math.round(window.innerHeight * 0.45)));
    expect(textareaHeight(wrapper)).toBe(`${cap}px`);
  });
});
