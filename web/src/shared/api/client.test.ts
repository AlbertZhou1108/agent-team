import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function stalledFetch() {
  vi.stubGlobal('fetch', vi.fn((_path, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
    else init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  })));
}
describe('API request lifetime', () => {
  it('times out a stalled read and allows a later successful retry', async () => {
    vi.useFakeTimers(); stalledFetch();
    const failed = expect(api.snapshot()).rejects.toThrow('读取超时');
    await vi.advanceTimersByTimeAsync(15000); await failed;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ groups: [] }))));
    expect(await api.snapshot()).toEqual({ groups: [] });
  });
  it('preserves caller cancellation instead of reporting a timeout', async () => {
    stalledFetch(); const controller = new AbortController();
    const failed = expect(api.snapshot(controller.signal)).rejects.toHaveProperty('name', 'AbortError');
    controller.abort(); await failed;
  });
  it('warns that a timed-out mutation may still execute', async () => {
    vi.useFakeTimers(); stalledFetch();
    const failed = expect(api.chooseDirectory()).rejects.toThrow('避免重复提交');
    await vi.advanceTimersByTimeAsync(330000); await failed;
  });
});
