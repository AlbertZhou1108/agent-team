import { describe, expect, it } from 'vitest';
import { tidyNoticeText } from '@/features/messages/system-notice';

const MSG = '786f45ed-6503-4aa3-9073-7d7b106afac1';
const MEMBER = 'f2259358-8ed7-4d46-838a-86afa38bf5d1';

describe('投递失败通知的展示清洗', () => {
  it('把成员投递失败里的消息与成员 UUID 换成不含标识的说法', () => {
    const legacy = `消息 ${MSG} 发给成员 ${MEMBER} 的会话失败：dsh 退出 (1)：请求超时。不会自动重试；核实后可用 /retry 明确重试。`;
    const shown = tidyNoticeText(legacy);
    expect(shown).toBe('发给成员的消息没有送达：dsh 退出 (1)：请求超时。不会自动重试；核实后可用 /retry 明确重试。');
    expect(shown).not.toContain(MSG);
    expect(shown).not.toContain(MEMBER);
  });

  it('Panel Agent 的旧通知同样清掉消息 id', () => {
    const legacy = `消息 ${MSG} 发给 Panel Agent 的会话失败：连接中断。不会自动重试。`;
    expect(tidyNoticeText(legacy)).toBe('发给 Panel Agent 的消息没有送达：连接中断。不会自动重试。');
  });

  it('已经干净的新通知保持原样', () => {
    const fresh = '发给「主 Agent」的消息没有送达：ERR_MODULE_NOT_FOUND: Cannot find module …/policy.mjs。不会自动重试，核实后可用 /retry 重试。';
    expect(tidyNoticeText(fresh)).toBe(fresh);
  });

  it('普通正文里的 UUID 不被改写', () => {
    const plain = `请看一下 ${MSG} 这条记录`;
    expect(tidyNoticeText(plain)).toBe(plain);
  });

  it('空文本原样返回', () => {
    expect(tidyNoticeText('')).toBe('');
  });
});
