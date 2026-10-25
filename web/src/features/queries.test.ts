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
