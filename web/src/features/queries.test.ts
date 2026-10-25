import { describe, it, expect, vi } from 'vitest';
import { createRenderer, defineComponent, ref } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import { useHistoryQuery, useMessagesQuery, useModelsQuery } from './queries';
vi.mock('@/shared/api/client', () => ({ api: { messages: vi.fn(), history: vi.fn(), models: vi.fn() } }));
const renderer = createRenderer<any, any>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null,
});
async function settle() { await new Promise(resolve => setTimeout(resolve, 15)); }
function mount(setup: () => void, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const app = renderer.createApp(defineComponent({ setup() { setup(); return () => null; } }));
  app.use(VueQueryPlugin, { queryClient: client }); app.mount({});
  return () => { app.unmount(); client.clear(); };
}
describe('panel loading boundaries', () => {
  it('requests history and model data only for the selected detail tab', async () => {
    vi.mocked(api.history).mockResolvedValue([]);
    vi.mocked(api.models).mockResolvedValue({ observations: [] } as any);
    vi.mocked(api.history).mockClear(); vi.mocked(api.models).mockClear();
    const historyEndpoint = ref<string>(); const modelEndpoint = ref<string>();
    const dispose = mount(() => { useHistoryQuery(historyEndpoint); useModelsQuery(modelEndpoint); });
    try {
      await settle(); expect(api.history).not.toHaveBeenCalled(); expect(api.models).not.toHaveBeenCalled();
      historyEndpoint.value = 'session'; await settle();
      expect(api.history).toHaveBeenCalledTimes(1); expect(api.models).not.toHaveBeenCalled();
      historyEndpoint.value = undefined; modelEndpoint.value = 'session'; await settle();
      expect(api.models).toHaveBeenCalledTimes(1); expect(api.history).toHaveBeenCalledTimes(1);
    } finally { dispose(); }
  });
  it('polls only new messages and loads older pages explicitly', async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({ seq: index + 51, id: String(index + 51) }));
    vi.mocked(api.messages).mockReset().mockResolvedValueOnce(first as any).mockResolvedValueOnce([{ seq: 101, id: '101' }] as any).mockResolvedValueOnce([{ seq: 50, id: '50' }] as any);
    let query!: ReturnType<typeof useMessagesQuery>;
    const dispose = mount(() => { query = useMessagesQuery('team', 'session'); });
    try {
      await settle(); expect(api.messages).toHaveBeenCalledTimes(1);
      await query.refetch();
      expect(vi.mocked(api.messages).mock.calls[1][4]).toBe(100);
      expect(query.rows.value).toHaveLength(51);
      await query.fetchNextPage();
      expect(vi.mocked(api.messages).mock.calls[2][1]).toBe(51);
      expect(query.rows.value[0].seq).toBe(50);
      expect(query.rows.value.at(-1)?.seq).toBe(101);
    } finally { dispose(); }
  });
});

it('normalizes a restored null endpoint before polling newer messages', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // JSON sessionStorage hydration converts the optional undefined key to null.
  client.setQueryData(['messages', 'team', null], [{ seq: 471, id: 'user-message' }]);
  vi.mocked(api.messages).mockReset().mockImplementation(async (_group, _before, _signal, endpoint) => {
    if (endpoint === null) throw new Error('不存在的团队会话: endpoint=null');
    return [{ seq: 474, id: 'interaction-anchor' }] as any;
  });
  let query!: ReturnType<typeof useMessagesQuery>;
  const dispose = mount(() => { query = useMessagesQuery('team'); }, client);
  try {
    await settle();
    expect(query.error.value).toBeNull();
    expect(query.rows.value.map(row => row.id)).toContain('interaction-anchor');
  } finally { dispose(); }
});

it('repairs the gap between restored history pages and a newer cached head', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['messages', 'team', null], [{ seq: 439, id: 'later-card' }]);
  client.setQueryData(['message-history', 'team', null], { pages: [[{ seq: 376, id: 'older' }]], pageParams: [null] });
  vi.mocked(api.messages).mockReset().mockImplementation((async (_group: string, before: number | undefined, _signal: AbortSignal, _endpoint: string | undefined, after: number | undefined) => {
    if (before === 439) return [{ seq: 376, id: 'older' }, { seq: 436, id: 'missing-card' }] as any;
    if (after === undefined) return [{ seq: 439, id: 'later-card' }] as any;
    return [];
  }) as any);
  let query!: ReturnType<typeof useMessagesQuery>;
  const dispose = mount(() => { query = useMessagesQuery('team'); }, client);
  try {
    await settle();
    expect(query.rows.value.map(row => row.id)).toEqual(['older', 'missing-card', 'later-card']);
    await query.refetch();
    expect(vi.mocked(api.messages).mock.calls.at(-1)?.[4]).toBe(439);
  } finally { dispose(); }
});

it('bridges a gap inside a restored head cache without history pages', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['messages', 'team', null], [
    { seq: 372, id: 'old-tail' },
    { seq: 439, id: 'later-card' },
  ]);
  vi.mocked(api.messages).mockReset().mockImplementation((async (_group: string, before: number | undefined, _signal: AbortSignal, _endpoint: string | undefined, after: number | undefined) => {
    if (before === 439) return [{ seq: 372, id: 'old-tail' }, { seq: 436, id: 'missing-card' }] as any;
    if (after === undefined) return [{ seq: 439, id: 'later-card' }] as any;
    return [];
  }) as any);
  let query!: ReturnType<typeof useMessagesQuery>;
  const dispose = mount(() => { query = useMessagesQuery('team'); }, client);
  try {
    await settle();
    expect(query.rows.value.map(row => row.id)).toEqual(['old-tail', 'missing-card', 'later-card']);
    expect(query.hasNextPage.value).toBe(false);
  } finally { dispose(); }
});

it('pages through several cached islands until the whole window is contiguous', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['messages', 'team', null], [
    { seq: 332, id: 'oldest' },
    { seq: 372, id: 'old-tail' },
    { seq: 439, id: 'later-card' },
  ]);
  vi.mocked(api.messages).mockReset().mockImplementation((async (_group: string, before: number | undefined, _signal: AbortSignal, _endpoint: string | undefined, after: number | undefined) => {
    if (before === 439) return [{ seq: 436, id: 'missing-card' }, { seq: 438, id: 'fill-438' }] as any;
    if (before === 436) return [{ seq: 332, id: 'oldest' }, { seq: 372, id: 'old-tail' }, { seq: 380, id: 'fill-380' }] as any;
    if (after === undefined) return [{ seq: 439, id: 'later-card' }] as any;
    return [];
  }) as any);
  let query!: ReturnType<typeof useMessagesQuery>;
  const dispose = mount(() => { query = useMessagesQuery('team'); }, client);
  try {
    await settle();
    expect(query.rows.value.map(row => row.id)).toEqual([
      'oldest', 'old-tail', 'fill-380', 'missing-card', 'fill-438', 'later-card',
    ]);
    expect(vi.mocked(api.messages).mock.calls.filter(call => call[1] !== undefined)).toHaveLength(2);
  } finally { dispose(); }
});
