const pad = (value: number) => String(value).padStart(2, '0');

function valid(date: Date) {
  return !Number.isNaN(date.getTime());
}

/** 完整时刻（本地时区）：`2026-11-20 18:22:41`。悬停提示与跨天文案共用。 */
export function formatAbsoluteTime(date: Date): string {
  if (!valid(date)) return '';
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${ymd} ${hms}`;
}

/** 只比较年月日：跨零点的判定不看时分秒。 */
export function isSameDay(a: Date, b: Date): boolean {
  if (!valid(a) || !valid(b)) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 会话流与投递弹窗共用的时间文案。
 *
 * 当天只给时分秒（日常绝大部分消息，保持消息头安静）；跨天补全年月日，
 * 让每一行自解释——翻几天前的记录时不必往上找最近的日期。
 * `now` 只用来判定"今天"，由调用方传入以便随时间推移重算。
 */
export function formatMessageTime(date: Date, now: Date = new Date()): string {
  if (!valid(date)) return '';
  const hms = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return isSameDay(date, now) ? hms : formatAbsoluteTime(date);
}
