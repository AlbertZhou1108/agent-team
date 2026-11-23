import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/shared/api/client';
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
  it('gives desktop verification enough budget to outlast the backend watchdog', async () => {
    vi.useFakeTimers(); stalledFetch();
    let settled = false;
    const pending = api.desktopVerify('codex', true).catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(60000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(120000);
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('请求超时');
  });
});

describe('chooseDirectory progressive enhancement', () => {
  it('prefers the native dialog when the desktop bridge is present', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const choose = vi.fn().mockResolvedValue({ path: '/tmp/picked' });
    vi.stubGlobal('agentTeam', { chooseDirectory: choose });
    expect(await api.chooseDirectory()).toEqual({ path: '/tmp/picked' });
    expect(choose).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('falls back to the HTTP picker in the browser entry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ path: '/tmp/http' })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.chooseDirectory()).toEqual({ path: '/tmp/http' });
    expect(fetchMock).toHaveBeenCalledWith('/api/local/directory-picker', expect.objectContaining({ method: 'POST' }));
  });
  it('forwards an external abort signal to the HTTP picker', async () => {
    stalledFetch();
    const controller = new AbortController();
    const failed = expect(api.chooseDirectory(controller.signal)).rejects.toHaveProperty('name', 'AbortError');
    controller.abort(); await failed;
  });
});
