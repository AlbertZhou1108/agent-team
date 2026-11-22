// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, nextTick, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { mount } from '@vue/test-utils';
import { CollapseReveal } from '@/components/ui/collapse-reveal';
import Disclosure from '@/components/ui/disclosure/Disclosure.vue';
import DisclosureChevron from '@/components/ui/disclosure/DisclosureChevron.vue';
import DisclosureFooter from '@/components/ui/disclosure/DisclosureFooter.vue';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { MetricCard, PanelState, SectionBlock } from '@/components/panel';

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

describe('ui primitives & panel blocks', () => {
  it('Separator size=inline uses h-3.5 without h-full override', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(Separator, { orientation: 'vertical', size: 'inline' }) }),
    );
    expect(html).toContain('data-size="inline"');
    expect(html).toContain('data-[orientation=vertical]:h-3.5');
    expect(html).not.toContain('data-[orientation=vertical]:h-full');
  });

  it('CollapseReveal logs DEV error when inner child uses v-if and leaves slot empty', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const Host = defineComponent({
        setup() {
          const open = ref(false);
          return () => h(CollapseReveal, { show: open.value }, () => null);
        },
      });
      const wrapper = mount(Host);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('[CollapseReveal]'),
      );
      wrapper.unmount();
    } finally {
      spy.mockRestore();
    }
  });

  it('DisclosureChevron & DisclosureFooter wire indicator, aria-controls and toggle state', async () => {
    const chevronHtml = await renderToString(
      createSSRApp({ render: () => h(DisclosureChevron, { open: true }) }),
    );
    expect(chevronHtml).toContain('data-part="disclosure-indicator"');
    expect(chevronHtml).toContain('rotate-180');

    const wrapper = mount(DisclosureFooter, {
      props: { collapsedLabel: '展开', expandedLabel: '收起', toggleTestId: 'toggle', revealTestId: 'reveal' },
      slots: {
        default: () => h('div', 'Details'),
        'footer-start': () => h('span', 'Legend'),
      },
    });
    const btn = wrapper.get('[data-testid="toggle"]');
    const reveal = wrapper.get('[data-testid="reveal"]');
    expect(btn.attributes('aria-expanded')).toBe('false');
    expect(btn.attributes('aria-controls')).toBe(reveal.attributes('id'));
    expect(reveal.attributes('data-open')).toBe('false');
    await btn.trigger('click');
    await nextTick();
    expect(btn.attributes('aria-expanded')).toBe('true');
    expect(reveal.attributes('data-open')).toBe('true');
    expect(btn.text()).toContain('收起');
    wrapper.unmount();
  });

  it('TabsList variant=underline propagates underline data-variant to TabsTrigger', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(Tabs, { modelValue: 'chat' }, () =>
            h(TabsList, { variant: 'underline' }, () => [
              h(TabsTrigger, { value: 'chat' }, () => '对话'),
              h(TabsTrigger, { value: 'trace' }, () => '轨迹'),
            ]),
          ),
      }),
    );
    expect(html).toContain('data-slot="tabs-list"');
    expect(html).toContain('data-variant="underline"');
  });

  it('SectionBlock & MetricCard render panel containers and KPI/progress layout', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(SectionBlock, { title: '总用量', meta: '2 回合' }, () =>
            h(MetricCard, { label: '缓存占比', value: '64.8%', progress: 64.8, subtitle: '14K / 21.5K' }),
          ),
      }),
    );
    expect(html).toContain('data-component="section-block"');
    expect(html).toContain('@container');
    expect(html).toContain('总用量');
    expect(html).toContain('2 回合');
    expect(html).toContain('data-component="metric-card"');
    expect(html).toContain('64.8%');
  });

  it('unifies control sizes (xs/sm/md/lg) and container sizes (sm/md/lg) cleanly', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h('div', [
            h(Button, { size: 'xs' }, () => 'XS'),
            h(Button, { size: 'icon-md' }, () => 'I'),
            h(Input, { size: 'sm' }),
            h(Select, {}, () => h(SelectTrigger, { size: 'sm' })),
            h(Badge, { size: 'xs' }, () => 'host'),
            h(Tabs, { modelValue: 'a' }, () =>
              h(TabsList, { size: 'xs' }, () => h(TabsTrigger, { value: 'a' }, () => '全部')),
            ),
            h(Card, { size: 'md' }, () => 'Card'),
            h(SectionBlock, { size: 'sm', layout: 'inline', title: '空态', meta: '无' }),
            h(PanelState, { size: 'sm', title: '暂无' }),
          ]),
      }),
    );
    expect(html).toContain('h-(--component-control-xs-height)');
    expect(html).toContain('size-(--component-control-height)');
    expect(html).toContain('h-(--component-control-sm-height)');
    expect(html).toContain('data-size="xs"');
    expect(html).toContain('data-slot="card"');
    expect(html).toContain('data-size="md"');
    expect(html).toContain('data-layout="inline"');
    expect(html).toContain('p-4');
  });

  it('propagates ToggleGroup reactive size updates to ToggleGroupItem', async () => {
    const size = ref<'sm' | 'lg'>('sm');
    const wrapper = mount(
      defineComponent({
        setup() {
          return () =>
            h(ToggleGroup, { type: 'single', size: size.value }, () =>
              h(ToggleGroupItem, { value: 'a' }, () => 'Opt'),
            );
        },
      }),
    );
    expect(wrapper.get('[data-slot="toggle-group-item"]').attributes('data-size')).toBe('sm');
    size.value = 'lg';
    await nextTick();
    expect(wrapper.get('[data-slot="toggle-group-item"]').attributes('data-size')).toBe('lg');
    wrapper.unmount();
  });
});
