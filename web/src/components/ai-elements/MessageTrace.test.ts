import { createRenderer, defineComponent, ref } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { expect, it, vi } from 'vitest';
import { useMessageTraceQuery } from '@/features/messages/trace-query';
import { api } from '@/shared/api/client';
vi.mock('@/shared/api/client', () => ({ api: { messageTrace: vi.fn(async () => ({ source: { kind: 'unknown' } })), turn: vi.fn() } }));

it('does not request traces for a full message history until one is expanded', async () => {
  const expanded = Array.from({ length: 100 }, () => ref(false));
  const renderer = createRenderer<any, any>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {},
    patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const app = renderer.createApp(defineComponent({ setup() {
    expanded.forEach((open, i) => useMessageTraceQuery(`message-${i}`, open));
    return () => null;
  } }));
  app.use(VueQueryPlugin, { queryClient: client });
  app.mount({});
  try {
    expect(api.messageTrace).not.toHaveBeenCalled();
    expanded[0]!.value = true;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(api.messageTrace).toHaveBeenCalledTimes(1);
    expect(api.turn).not.toHaveBeenCalled();
  } finally { app.unmount(); client.clear(); }
});
