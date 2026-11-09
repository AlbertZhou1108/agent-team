import { describe, expect, it } from 'vitest';
import {
  buildOutlineSegments,
  layoutOutlineBands,
  OUTLINE_BAND_PITCH,
  OUTLINE_MAX_BANDS,
  OUTLINE_MAX_HEIGHT,
  resolveCurrentSegment,
  type OutlineSegment,
} from '@/features/messages/outline-segments';
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

describe('layoutOutlineBands', () => {
  const segments: OutlineSegment[] = [0, 1, 2, 3].map(index => ({
    id: `s${index}`,
    index,
    title: `第 ${index + 1} 段`,
  }));

  /** 段落依次占 0..1 的哪一段，四舍五入到小数点后四位便于断言。 */
  const ranges = (bands: ReturnType<typeof layoutOutlineBands>) =>
    bands.map(band => [
      +band.start.toFixed(4),
      +band.end.toFixed(4),
    ]);

  const many = (count: number): OutlineSegment[] =>
    Array.from({ length: count }, ((_, index) => ({
      id: `s${index}`,
      index,
      title: `第 ${index + 1} 段`,
    })));

  it('每块等高:与段落长短无关', () => {
    const bands = layoutOutlineBands(segments);

    expect(ranges(bands)).toEqual([
      [0, 0.25],
      [0.25, 0.5],
      [0.5, 0.75],
      [0.75, 1],
    ]);
  });

  it('每块的高度彼此完全相同', () => {
    const bands = layoutOutlineBands(many(7));

    const heights = bands.map(band => +(band.end - band.start).toFixed(6));
    expect(new Set(heights).size).toBe(1);
  });

  it('一段一块,顺序与段序号一致', () => {
    const bands = layoutOutlineBands(segments);

    expect(bands.map(band => band.indexes)).toEqual([[0], [1], [2], [3]]);
    expect(bands.map(band => band.id)).toEqual(['s0', 's1', 's2', 's3']);
  });

  it('段数超出轨道容量时按顺序并组,块数收到容量上限', () => {
    // 76 段、轨道只放得下 49 块 -> 收到 49 块:27 块装 2 段、22 块装 1 段。
    const bands = layoutOutlineBands(many(76), { maxBands: 49 });

    expect(bands).toHaveLength(49);
    expect(bands[0]!.indexes).toEqual([0, 1]);
    expect(bands[27]!.indexes).toHaveLength(1);
  });

  it('并组时把余数摊到前面的块,各块段数最多差一段', () => {
    const bands = layoutOutlineBands(many(76), { maxBands: 49 });

    const sizes = bands.map(band => band.indexes.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBe(1);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(76);
  });

  it('并组后仍保持连续、不丢段、不重复', () => {
    const bands = layoutOutlineBands(many(50), { maxBands: 7 });

    const flattened = bands.flatMap(band => band.indexes);
    expect(flattened).toEqual(Array.from({ length: 50 }, (_, index) => index));
  });

  it('并组块的锚点与标题取组内第一段,跳转落到这一组开头', () => {
    const bands = layoutOutlineBands(many(20), { maxBands: 4 });

    expect(bands[1]!.id).toBe('s5');
    expect(bands[1]!.title).toBe('第 6 段');
  });

  it('并组后每块依然等高,且刚好铺满轨道', () => {
    const bands = layoutOutlineBands(many(20), { maxBands: 4 });

    expect(bands[0]!.start).toBe(0);
    expect(bands.at(-1)!.end).toBe(1);
    const heights = bands.map(band => +(band.end - band.start).toFixed(6));
    expect(new Set(heights)).toEqual(new Set([0.25]));
  });

  it('容量够用时不做任何并组', () => {
    expect(layoutOutlineBands(many(10), { maxBands: 10 })).toHaveLength(10);
    expect(layoutOutlineBands(many(10), { maxBands: 40 })).toHaveLength(10);
  });

  it('容量为 0 或负数时至少留一块,不产生空轨道', () => {
    expect(layoutOutlineBands(segments, { maxBands: 0 })).toHaveLength(1);
    expect(layoutOutlineBands(segments, { maxBands: -3 })).toHaveLength(1);
  });

  it('极端段数(1000)下粒度均匀放粗,块数封顶在容量', () => {
    const bands = layoutOutlineBands(many(1000), { maxBands: OUTLINE_MAX_BANDS });

    expect(bands).toHaveLength(OUTLINE_MAX_BANDS);
    const sizes = bands.map(band => band.indexes.length);
    // 1000 / 40 整除,每块恰好 25 段;不整除时最多差一段。
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(1000);
    expect(new Set(sizes)).toEqual(new Set([25]));
  });

  it('没有段时不给块', () => {
    expect(layoutOutlineBands([])).toEqual([]);
  });
});

describe('outline track budget', () => {
  it('最大高度恰好被格高整除:容量 × 格高 = 最大高度', () => {
    expect(OUTLINE_MAX_BANDS).toBe(Math.floor(OUTLINE_MAX_HEIGHT / OUTLINE_BAND_PITCH));
    expect(OUTLINE_MAX_BANDS * OUTLINE_BAND_PITCH).toBe(OUTLINE_MAX_HEIGHT);
  });

  it('容量是 40 块 / 320px:粒度封顶的锚', () => {
    expect(OUTLINE_BAND_PITCH).toBe(8);
    expect(OUTLINE_MAX_BANDS).toBe(40);
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
