import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createPinia } from 'pinia';
import TeamHome from './TeamHome.vue';
import type { Group } from '@/shared/api/raw-types';

vi.mock('@/features/productivity/HomeWorkbench.vue', () => ({
  default: defineComponent({
    setup: (_props, { slots }) => () => h('div', { 'data-testid': 'workbench' }, [slots.actions?.()]),
  }),
}));
vi.mock('@/features/telemetry/TelemetryOverview.vue', () => ({
  default: defineComponent({ setup: () => () => h('div', { 'data-testid': 'telemetry' }) }),
}));

const groups: Group[] = [
  { id: 'alpha', name: '团队甲', workspace: '/tmp/alpha', lead: null, created: '2026-01-01T00:00:00Z' },
];

function renderHome() {
  const app = createSSRApp(TeamHome, {
    groups,
    members: [],
    runningByGroup: {},
    runningEndpoints: [],
  });
  app.use(createPinia());
  app.component('RouterLink', defineComponent({
    props: { to: { type: [String, Object], default: '' } },
    setup: (_props, { slots }) => () => h('a', slots.default?.()),
  }));
  return renderToString(app);
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
  });
});

describe('team home directory cards', () => {
  it('starts the team directory collapsed and keeps drag sorting and the pin toggle', async () => {
    const html = await renderHome();
    expect(html).toMatch(/data-state="closed"[^>]*data-slot="disclosure"/);
    expect((html.match(/data-slot="separator"/g) ?? []).length).toBe(2);
    expect(html).toContain('团队甲');
    expect(html).toContain('draggable="true"');
    expect(html).toContain('首页置顶团队');
    expect(html).toContain('aria-label="打开 Panel Agent"');
    expect(html).not.toContain('>打开 Panel Agent<');
    expect(html).not.toContain('lucide-arrow-up-right');
    expect(html).not.toContain('前移');
    expect(html).not.toContain('后移');
  });
});
