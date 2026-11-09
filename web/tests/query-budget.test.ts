// 轮询预算:页面级 2 秒查询只允许消息头/互动卡/运行状态;其余降频或按需。
// 所有区间必须走 QUERY_POLLING 桶,禁止在调用点写数字;infinite query 不允许后台轮询。
import { describe, it, expect } from 'vitest';
import { QUERY_POLLING } from '@/features/queries';

// 用 Vite 的 raw glob 读源码,避免在 web 侧引入 Node 类型。
const sources = import.meta.glob('../src/**/*.{ts,vue}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const sourceFiles = Object.entries(sources).filter(([path]) => !path.endsWith('.test.ts'));

describe('query polling budget', () => {
  it('keeps polling buckets ordered and slow enough', () => {
    expect(QUERY_POLLING.fast).toBeLessThanOrEqual(2000);
    expect(QUERY_POLLING.slow).toBeGreaterThanOrEqual(5000);
    expect(QUERY_POLLING.ambient).toBeGreaterThan(QUERY_POLLING.slow);
    expect(QUERY_POLLING.rare).toBeGreaterThan(QUERY_POLLING.ambient);
  });

  it('does not inline numeric refetch intervals', () => {
    const offenders: string[] = [];
    for (const [path, source] of sourceFiles) {
      source.split('\n').forEach((line, index) => {
        if (/refetchInterval:\s*\d+/.test(line)) offenders.push(`${path}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('does not poll infinite queries in the background', () => {
    const offenders: string[] = [];
    for (const [path, source] of sourceFiles) {
      let from = 0;
      while (true) {
        const start = source.indexOf('useInfiniteQuery({', from);
        if (start < 0) break;
        const end = source.indexOf('\n  });', start);
        const block = source.slice(start, end < 0 ? undefined : end);
        if (block.includes('refetchInterval')) offenders.push(path);
        from = start + 1;
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});
