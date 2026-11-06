import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import Disclosure from './Disclosure.vue';

describe('shared disclosure contract', () => {
  it('places explanatory text inside the same hidden content as the body', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(Disclosure, { open: false }, {
      summary: () => 'Theme', description: () => 'Theme help', default: () => 'Theme choices',
    }) }));
    const hiddenContent = html.indexOf('data-open="false"');
    expect(hiddenContent).toBeGreaterThan(-1);
    expect(html.indexOf('Theme help')).toBeGreaterThan(hiddenContent);
    expect(html.indexOf('Theme choices')).toBeGreaterThan(hiddenContent);
  });
  it('keeps independent actions outside the trigger and respects explicit disabled state', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(Disclosure, { defaultOpen: true, disabled: true, headingLevel: 2 }, {
      summary: () => 'Groups', actions: () => h('button', { type: 'button' }, 'Create'), description: () => 'Description', default: () => 'Content',
    }) }));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/<button[^>]*disabled/);
    const trigger = html.match(/<button[^>]*data-slot="disclosure-trigger"[^>]*>(.*?)<\/button>/s)?.[1];
    expect(trigger).toContain('Groups');
    expect(trigger).not.toContain('Create');
    expect(html).toContain('data-slot="disclosure-actions"');
    expect(html).toContain('Description');
    expect(html).toMatch(/<h2 data-slot="disclosure-title"><button/);
  });
  it('hides header actions while collapsed - actions scope to the hidden content', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(Disclosure, { open: false, headingLevel: 2 }, {
      summary: () => 'Groups', actions: () => h('button', { type: 'button' }, 'Create'), default: () => 'Content',
    }) }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-slot="disclosure-actions"');
    expect(html).not.toContain('Create');
  });
  it('keeps section-level actions visible while collapsed when asked to', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(Disclosure, { open: false, persistActions: true }, {
      summary: () => '协调遥测', actions: () => h('button', { type: 'button' }, '关闭'), default: () => 'Content',
    }) }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-slot="disclosure-actions"');
    expect(html).toContain('关闭');
  });
  it('keeps nested state independent and connects each trigger to its own content', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(Disclosure, { defaultOpen: true }, {
      summary: () => 'Parent',
      default: () => h(Disclosure, {}, { summary: () => 'Child', default: () => h('button', 'Child action') }),
    }) }));
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1);
    const ids = [...html.matchAll(/aria-controls="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('inert');
    expect(html).toContain('Child action');
  });
  it('supports externally selected detail state and preserves summary/content slots', async () => {
    for (const open of [false, true]) {
      const html = await renderToString(createSSRApp({ render: () => h(Disclosure, { open, variant: 'card' }, {
        summary: () => ['Session', h('span', '3 records')], default: () => h('pre', 'record payload'),
      }) }));
      expect(html).toContain(`aria-expanded="${open}"`);
      expect(html).toContain('3 records');
      expect(html).toContain('record payload');
      expect(html).toContain('data-variant="card"');
    }
  });
});
