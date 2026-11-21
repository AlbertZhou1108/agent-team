import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createPinia } from 'pinia';
import { motionDurationMs, resolveMotionStyle } from '@/shared/motion';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toggle } from '@/components/ui/toggle';
import RunStatusCard from '@/components/ai-elements/RunStatusCard.vue';
import type { StreamView } from '@/features/messages/adapters';

describe('resolveMotionStyle', () => {
  it('follows the system preference only when set to system', () => {
    expect(resolveMotionStyle('system', true)).toBe('reduced');
    expect(resolveMotionStyle('system', false)).toBe('simple');
  });

  it('lets an explicit user choice win over the system preference', () => {
    expect(resolveMotionStyle('reduced', false)).toBe('reduced');
    expect(resolveMotionStyle('simple', true)).toBe('simple');
    expect(resolveMotionStyle('soft', true)).toBe('soft');
    expect(resolveMotionStyle('lively', false)).toBe('lively');
  });
});

describe('motionDurationMs', () => {
  it('uses the contract tiers instead of ad-hoc numbers', () => {
    // 无 DOM(节奏系数回落为 1)时即契约基准:150 / 220 / 320。
    expect(motionDurationMs('fast')).toBe(150);
    expect(motionDurationMs('normal')).toBe(220);
    expect(motionDurationMs('slow')).toBe(320);
  });
});

describe('motion transition coverage contracts', () => {
  it('interactive primitives include background and border transitions', async () => {
    const html = await renderToString(createSSRApp({
      render: () => h('div', [
        h(Input, { modelValue: '' }),
        h(Textarea, { modelValue: '' }),
        h(Toggle, null, () => 'T'),
        h(Tabs, { modelValue: 'a' }, () => h(TabsList, null, () => h(TabsTrigger, { value: 'a' }, () => 'Tab'))),
      ]),
    }));
    const classes = [...html.matchAll(/class="([^"]+)"/g)].map(match => match[1]);
    expect(classes.filter(cls => cls.includes('transition-[color,background-color,border-color,box-shadow]')).length).toBe(4);
  });

  it('RunStatusCard renders collapsible detail via CollapseReveal', async () => {
    const rows: StreamView[] = [{
      pending: true,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      runPhase: 'thinking',
      tool: { name: 'read' },
      reasoning: '',
      message: {
        id: 'm1',
        seq: 1,
        pairKey: 'lead:user',
        senderName: 'Lead',
        recipientName: '用户',
        senderIsLead: true,
        senderIsUser: false,
        kind: 'send',
        text: '',
        createdAt: new Date().toISOString(),
      },
    }];
    const app = createSSRApp({
      render: () => h(RunStatusCard, { source: () => rows }),
    });
    app.use(createPinia());
    const html = await renderToString(app);
    expect(html).toContain('class="collapse-reveal"');
    expect(html).toContain('data-open="false"');
  });
});
