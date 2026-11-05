import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createPinia, setActivePinia } from 'pinia';
import { useUiStore } from '@/stores/ui';
import NoteComposer from './NoteComposer.vue';

// 折叠只看取舍,不测动效:收起时入口行在、输入区不可聚焦;展开时相反。
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

describe('NoteComposer', () => {
  it('默认收起:只留一行入口,不给完整输入框占位', async () => {
    const html = await render();
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('想到什么就写下来……');
    expect(html).toContain('aria-expanded="false"');
  });

  it('展开后给出完整输入区与保存入口', async () => {
    const html = await renderExpanded();
    expect(html).toContain('data-state="open"');
    expect(html).toContain('记一条想法');
    expect(html).toContain('记下来');
    expect(html).toContain('收起');
  });
});
