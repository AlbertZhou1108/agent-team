import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { ToggleGroup, ToggleGroupItem } from '.';

describe('segmented choices', () => {
  it('preserves selection semantics and disabled options in the shared presentation', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(ToggleGroup, { type: 'single', modelValue: 'light', presentation: 'segmented', 'aria-label': 'Mode' }, {
      default: () => [h(ToggleGroupItem, { value: 'light' }, () => 'Light'), h(ToggleGroupItem, { value: 'dark', disabled: true }, () => 'Dark')],
    }) }));
    expect(html).toContain('data-presentation="segmented"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-state="on"');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain('aria-label="Mode"');
  });
});
