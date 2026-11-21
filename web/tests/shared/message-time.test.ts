import { describe, expect, it } from 'vitest';
import { formatAbsoluteTime, formatMessageTime, isSameDay } from '@/shared/message-time';

/** 用本地时间构造，避免测试受运行机器时区影响。 */
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
