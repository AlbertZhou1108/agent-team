import { describe, it, expect, vi } from 'vitest';
import { createRenderer, defineComponent, ref } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import { useMessagesQuery, useTurnsQuery } from './queries';
vi.mock('@/shared/api/client', () => ({ api: { messages: vi.fn(), turns: vi.fn() } }));
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
  function turn(id: string, ordinal: number, eventCount = 1) {
    return { id, state: 'completed', created: '2026-01-01T00:00:00Z', ended: null, ordinal, eventCount, firstSeq: 1, lastSeq: 2 };
  }
  it('requests turn summaries only once an endpoint is selected', async () => {
    vi.mocked(api.turns).mockResolvedValue({ turns: [], unaffiliated: [], nextAfter: null } as any);
    const endpoint = ref<string>();
    const dispose = mount(() => { useTurnsQuery(endpoint); });
    try {
      await settle(); expect(api.turns).not.toHaveBeenCalled();
      endpoint.value = 'session'; await settle();
      // 单条 infinite 查询:首屏取第一页(最旧在前),无后台轮询。
      expect(api.turns).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.turns).mock.calls[0][0]).toBe('session');
    } finally { dispose(); }
  });
  it('pages turns forward from the first turn and keeps loaded pages frozen', async () => {
    // ordinal 是全会话全局编号:第二页接续第一页,不重新从 1 数。
    const page = (ids: string[], ordinalBase: number, nextAfter: string | null) => ({
      turns: ids.map((id, index) => turn(id, ordinalBase + index, (index + 1) * 10)),
      unaffiliated: ids[0] === 't1'
        ? [{ seq: 1, conversation_id: 'session', event: '{}', created: '2026-01-01', turn_id: null }]
        : [],
      nextAfter,
    });
    vi.mocked(api.turns).mockImplementation(async (_endpoint, after) => (
      !after ? page(['t1', 't2'], 1, 't2') : page(['t3', 't4'], 3, null)
    ) as any);
    let query!: ReturnType<typeof useTurnsQuery>;
    const dispose = mount(() => { query = useTurnsQuery('session'); });
    try {
      await settle();
      // 正序输出,序号即展示序;游离事件取自首页。
      expect(query.turns.value.map(item => item.id)).toEqual(['t1', 't2']);
      expect(query.unaffiliated.value).toHaveLength(1);
      await query.fetchNextPage(); await settle();
      expect(query.turns.value.map(item => item.id)).toEqual(['t1', 't2', 't3', 't4']);
      // 尾页无游标:加载更多按钮消失。
      expect(query.hasNextPage.value).toBe(false);
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

it('stops observing panel resources when hidden and isolates team caches', async () => {
  const { useResourceQuery } = await import('./queries');
  const visible = ref(false); const team = ref('one');
  const load = vi.fn(async () => ({ team: team.value }));
  let query!: ReturnType<typeof useResourceQuery<{ team: string }>>;
  const dispose = mount(() => { query = useResourceQuery(() => ['group', team.value, 'tasks'], load, visible, false); });
  try {
    await settle(); expect(load).not.toHaveBeenCalled();
    visible.value = true; await settle(); expect(query.data.value).toEqual({ team: 'one' });
    visible.value = false; team.value = 'two'; await settle();
    expect(load).toHaveBeenCalledTimes(1); expect(query.data.value).toBeUndefined();
    visible.value = true; await settle(); expect(query.data.value).toEqual({ team: 'two' });
  } finally { dispose(); }
});
