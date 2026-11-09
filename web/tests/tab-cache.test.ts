import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/vue-query';
import { installTabCache } from '@/shared/api/tab-cache';

function store() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } as Storage;
}
const page = { addEventListener() {}, removeEventListener() {} };
describe('tab message cache', () => {
  it('restores loaded history and pagination after reload without persisting runtime state', () => {
    const storage = store(); const first = new QueryClient();
    const dispose = installTabCache(first, storage, page);
    const key = ['message-history', 'team', 'session'];
    first.setQueryData(key, { pages: [[{ seq: 50, text: 'older' }]], pageParams: [undefined] });
    first.setQueryData(['messages', 'team', 'session'], [{ seq: 100 }]);
    first.setQueryData(['snapshot'], { running: ['stale'], session_key: 'test-only' });
    dispose(); first.clear();
    const restored = new QueryClient(); const stop = installTabCache(restored, storage, page);
    expect(restored.getQueryData(key)).toMatchObject({ pages: [[{ seq: 50 }]], pageParams: [null] });
    expect(restored.getQueryData(['messages', 'team', 'session'])).toEqual([{ seq: 100 }]);
    expect(restored.getQueryData(['snapshot'])).toBeUndefined();
    const freshTab = new QueryClient(); const closeFresh = installTabCache(freshTab, store(), page);
    expect(freshTab.getQueryData(key)).toBeUndefined();
    stop(); closeFresh(); restored.clear(); freshTab.clear();
  });
  it('remains usable when session storage is full', () => {
    const client = new QueryClient(); const storage = store();
    storage.setItem = () => { throw new Error('quota'); };
    const stop = installTabCache(client, storage, page);
    client.setQueryData(['messages', 'team'], [{ seq: 1 }]);
    expect(stop).not.toThrow();
    expect(client.getQueryData(['messages', 'team'])).toEqual([{ seq: 1 }]);
    client.clear();
  });
});
