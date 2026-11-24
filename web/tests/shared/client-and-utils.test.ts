import { describe, afterEach, expect, it, vi } from 'vitest';
import { api } from '@/shared/api/client';
import { formatAbsoluteTime, formatMessageTime, isSameDay } from '@/shared/message-time';
import { QueryClient } from '@tanstack/vue-query';
import { installTabCache } from '@/shared/api/tab-cache';
import { motionDurationMs, resolveMotionStyle } from '@/shared/motion';
import { resultLink } from '@/shared/result-links';
import { matchingEntries, navigationEntries, withoutDisabledPlugins } from '@/features/productivity/navigation';
import { allPluginStaticEntries } from '@/plugins';

describe('client', () => {
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
});

describe('message-time', () => {
  const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0) =>
    new Date(y, m - 1, d, h, min, s);

  describe('消息时间文案', () => {
    it('当天只给时分秒', () => {
      expect(formatMessageTime(at(2026, 11, 21, 20, 5, 12), at(2026, 11, 21, 23, 59, 0))).toBe(
        '20:05:12',
      );
    });

    it('同一天的不同时刻判定为同一天，与时分无关', () => {
      expect(isSameDay(at(2026, 11, 21, 0, 0, 0), at(2026, 11, 21, 23, 59, 59))).toBe(true);
      expect(formatMessageTime(at(2026, 11, 21, 0, 0, 0), at(2026, 11, 21, 23, 59, 59))).toBe(
        '00:00:00',
      );
    });

    it('跨天补全年月日', () => {
      expect(formatMessageTime(at(2026, 11, 20, 18, 22, 41), at(2026, 11, 21, 20, 5, 12))).toBe(
        '2026-11-20 18:22:41',
      );
    });

    it('午夜边界：23:59:59 与次日 00:00:00 不是同一天', () => {
      const before = at(2026, 11, 20, 23, 59, 59);
      const after = at(2026, 11, 21, 0, 0, 0);
      expect(isSameDay(before, after)).toBe(false);
      expect(formatMessageTime(before, after)).toBe('2026-11-20 23:59:59');
    });

    it('跨月与跨年同样按完整日期展示', () => {
      expect(formatMessageTime(at(2026, 10, 31, 23, 0, 0), at(2026, 11, 1, 9, 0, 0))).toBe(
        '2026-10-31 23:00:00',
      );
      expect(formatMessageTime(at(2025, 12, 31, 23, 59, 59), at(2026, 1, 1, 0, 0, 1))).toBe(
        '2025-12-31 23:59:59',
      );
    });

    it('月日时分秒都补零', () => {
      expect(formatAbsoluteTime(at(2026, 1, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
    });

    it('无效日期返回空串，不产出 NaN', () => {
      const invalid = new Date('not a date');
      expect(formatMessageTime(invalid, at(2026, 11, 21))).toBe('');
      expect(formatAbsoluteTime(invalid)).toBe('');
      expect(isSameDay(invalid, at(2026, 11, 21))).toBe(false);
    });

    it('未来日期同样按跨天处理，不会因为"不是过去"而丢日期', () => {
      expect(formatMessageTime(at(2026, 11, 22, 8, 0, 0), at(2026, 11, 21, 20, 0, 0))).toBe(
        '2026-11-22 08:00:00',
      );
    });
  });
});

describe('tab-cache', () => {
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
});

describe('motion', () => {
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
      expect(motionDurationMs('fast')).toBe(150);
      expect(motionDurationMs('normal')).toBe(220);
      expect(motionDurationMs('slow')).toBe(320);
    });
  });
});

describe('result-links', () => {
  describe('result file links', () => {
    it('uses the current conversation scope and preserves unrelated links', () => {
      const target = resultLink('/Users/me/工作/result.txt', { group: 'team' });
      const url = new URL(target, 'http://local');
      expect(url.pathname).toBe('/api/files');
      expect(url.searchParams.get('group')).toBe('team');
      expect(url.searchParams.get('path')).toBe('/Users/me/工作/result.txt');
      expect(resultLink('https://example.com/file.txt', { panel: '1' })).toBe('https://example.com/file.txt');
      expect(resultLink('/api/panel-agent/attachments/a', { panel: '1' })).toBe('/api/panel-agent/attachments/a');
      expect(resultLink('/tmp/result.txt')).toBe('/tmp/result.txt');
      expect(resultLink('file://remote/private.txt', { panel: '1' })).toBe('');
    });
  });
});

describe('navigation', () => {
  describe('withoutDisabledPlugins', () => {
    it('插件禁用后，其静态页面条目不进全局搜索；核心条目不受影响', () => {
      const pluginStatic = allPluginStaticEntries();
      const combined = [...navigationEntries, ...pluginStatic];
      const disabled = { 'builtin.notes': true };
      const ids = withoutDisabledPlugins(combined, disabled).map((entry) => entry.id);
      expect(ids).not.toContain('notes');
      expect(ids).toContain('home');
      expect(matchingEntries(withoutDisabledPlugins(combined, disabled), '随心记')).toEqual([]);
      expect(withoutDisabledPlugins(combined, {}).map((entry) => entry.id)).toContain('notes');
    });

    it('缺 pluginId 的旧最近访问记录按已注册静态条目回查归属', () => {
      const pluginStatic = allPluginStaticEntries();
      const legacyRecent = [
        { id: 'notes', label: '随心记', path: '/notes' },
        { id: 'agent', label: 'Panel Agent', path: '/agent' },
      ];
      expect(
        withoutDisabledPlugins(legacyRecent, { 'builtin.notes': true }, pluginStatic).map(
          (entry) => entry.id,
        ),
      ).toEqual(['agent']);
      expect(withoutDisabledPlugins(legacyRecent, { 'builtin.search': true }, pluginStatic)).toHaveLength(2);
    });
  });
});
