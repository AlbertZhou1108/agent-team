import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useTeamDirectiveStore } from './team-directives';
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/shared/api/client', () => ({
  api: { sendTeamDirective: mocks.send },
  ApiError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
}));
let storage: Record<string, string>;
beforeEach(() => {
  storage = {};
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage[k] ?? null, setItem: (k: string, v: string) => { storage[k] = v; } });
  setActivePinia(createPinia());
  mocks.send.mockReset();
});
const receipt = { messageId: 'm', operationId: 'op', status: 'queued', recipient: 'lead', seq: 1, created: '', error: null };
describe('team directive drafts and retries', () => {
  it('isolates teams, persists drafts and keeps the pending identity across network failure', async () => {
    const store = useTeamDirectiveStore();
    store.setDraft('A', 'hello'); store.setDraft('B', 'other');
    mocks.send.mockRejectedValueOnce(new Error('network lost'));
    await store.send('A', 'lead');
    const first = mocks.send.mock.calls[0]![1];
    expect(store.entry('A').draft).toBe('hello');
    expect(store.entry('B').draft).toBe('other');
    setActivePinia(createPinia());
    const restored = useTeamDirectiveStore();
    expect(restored.entry('A').attempt?.operationId).toBe(first.operationId);
    mocks.send.mockResolvedValueOnce(receipt);
    await restored.send('A', 'new-controller');
    expect(mocks.send.mock.calls[1]![1]).toEqual(first);
    expect(restored.entry('A').draft).toBe('');
    expect(restored.entry('B').draft).toBe('other');
  });
  it('does not erase text typed while submission is pending, or allow double submit', async () => {
    let resolve!: (value: unknown) => void;
    mocks.send.mockImplementation(() => new Promise(r => { resolve = r; }));
    const store = useTeamDirectiveStore(); store.setDraft('A', 'first');
    const pending = store.send('A', 'lead');
    await store.send('A', 'lead');
    store.setDraft('A', 'second');
    resolve(receipt); await pending;
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(store.entry('A').draft).toBe('second');
    expect(store.entry('A').sending).toBe(false);
  });
  it('editing an ambiguously failed request creates a distinct operation', async () => {
    mocks.send.mockRejectedValue(new Error('network'));
    const store = useTeamDirectiveStore(); store.setDraft('A', 'first'); await store.send('A', 'lead');
    store.setDraft('A', 'second'); await store.send('A', 'lead');
    expect(mocks.send.mock.calls[0]![1].operationId).not.toBe(mocks.send.mock.calls[1]![1].operationId);
  });
});
