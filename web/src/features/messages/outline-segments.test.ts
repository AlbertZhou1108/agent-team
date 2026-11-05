import { describe, expect, it } from 'vitest';
import { buildOutlineSegments, resolveCurrentSegment } from './outline-segments';
import type { MessageView } from '@/shared/models/view-types';

let seq = 0;
function message(overrides: Partial<MessageView> = {}): MessageView {
  seq += 1;
  return {
    id: `m${seq}`,
    seq,
    pairKey: 'a:b',
    senderName: '对话成员甲',
    recipientName: 'Panel Agent',
    senderIsLead: false,
    senderIsUser: false,
    kind: 'send',
    text: '普通消息',
    createdAt: '2026-11-05T00:00:00.000Z',
    turnId: null,
    ...overrides,
  };
}

const user = (text: string) => message({ senderIsUser: true, senderName: '用户指令', text });

describe('buildOutlineSegments', () => {
  it('按用户消息切段，内部往返不额外成段', () => {
    const messages = [
      user('第一件事'),
      message(),
      message(),
      user('第二件事'),
      message(),
      user('第三件事'),
    ];

    const segments = buildOutlineSegments(messages);

    expect(segments.map(segment => segment.title)).toEqual(['第一件事', '第二件事', '第三件事']);
    expect(segments.map(segment => segment.index)).toEqual([0, 1, 2]);
    expect(segments[0]!.id).toBe(messages[0]!.id);
  });

  it('用户消息不足三根时不给刻度', () => {
    expect(buildOutlineSegments([user('一'), user('二')])).toEqual([]);
  });

  it('没有用户消息的纯 Agent 会话不给刻度', () => {
    expect(buildOutlineSegments([message(), message(), message()])).toEqual([]);
  });

  it('标题取首行、压空白、超长截断，空文本回落到序号', () => {
    const segments = buildOutlineSegments([
      user('\n  第一行  有 空格 \n第二行'),
      user('很长'.repeat(30)),
      user('   '),
    ]);

    expect(segments[0]!.title).toBe('第一行 有 空格');
    expect(segments[1]!.title).toHaveLength(24);
    expect(segments[2]!.title).toBe('第 3 段');
  });
});

describe('resolveCurrentSegment', () => {
  const anchors = [
    { id: 'a', top: -500 },
    { id: 'b', top: -20 },
    { id: 'c', top: 300 },
    { id: 'd', top: 900 },
  ];

  it('取顶部已越过视口顶的最后一条', () => {
    expect(resolveCurrentSegment(anchors, 0)).toBe('b');
  });

  it('恰好压线算这一条', () => {
    expect(resolveCurrentSegment(anchors, 300)).toBe('c');
  });

  it('还没滚动时取第一段', () => {
    expect(resolveCurrentSegment([{ id: 'a', top: 40 }, { id: 'b', top: 800 }], 0)).toBe('a');
  });

  it('没有锚点时不给答案', () => {
    expect(resolveCurrentSegment([], 0)).toBeNull();
  });
});
