import { describe, expect, it } from 'vitest';
import { buildRunRows, elapsedLabel, runPhaseOf, toolActionLabel } from './run-rows';
import type { StreamView } from './adapters';

function view(overrides: Partial<StreamView> = {}): StreamView {
  return {
    message: {
      id: 'stream:turn-1',
      seq: Number.MAX_SAFE_INTEGER,
      pairKey: 'panel',
      senderName: 'Panel Agent',
      recipientName: '用户',
      senderIsLead: false,
      senderIsUser: false,
      kind: 'send',
      text: '',
      createdAt: '2026-10-30T00:00:00.000Z',
    },
    pending: true,
    turnId: 'turn-1',
    startedAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('run rows', () => {
  it('uses the server phase and falls back to content when it is absent', () => {
    expect(runPhaseOf(view({ runPhase: 'tool', tool: { name: 'team_read' } }))).toBe('tool');
    expect(runPhaseOf(view())).toBe('accepted');
    expect(runPhaseOf(view({ message: { ...view().message, text: '正文' } }))).toBe('writing');
    expect(runPhaseOf(view({ reasoning: '思考' }))).toBe('thinking');
  });

  it('aggregates the turn stream and its tool draft into one row', () => {
    const rows = buildRunRows([
      view({ message: { ...view().message, text: '正文' }, runPhase: 'writing' }),
      view({ message: { ...view().message, id: 'stream:tool', text: '草稿' }, toolCallId: 'call-1', runPhase: 'tool' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'turn-1', name: 'Panel Agent', phase: 'writing' });
    // 工具草稿不改变回合阶段,避免正文已开始时被工具事件拉回“调用工具”。
    expect(rows[0]!.tool).toBeNull();
  });

  it('keeps one row per concurrent turn and picks the longest reasoning', () => {
    const rows = buildRunRows([
      view({ turnId: 'a', message: { ...view().message, id: 'stream:a', senderName: 'A' }, reasoning: '短' }),
      view({ turnId: 'b', message: { ...view().message, id: 'stream:b', senderName: 'B' }, reasoning: '更长的思考' }),
    ]);
    expect(rows.map(row => row.name)).toEqual(['A', 'B']);
    expect(rows[1]!.reasoning).toBe('更长的思考');
  });

  it('labels known tools with the team name and hides unknown internal names', () => {
    expect(toolActionLabel({ name: 'team_read', groupId: 'g1' }, { g1: '圆桌' })).toBe('正在读取「圆桌」的团队消息');
    expect(toolActionLabel({ name: 'team_read', groupId: null })).toBe('正在读取团队消息');
    expect(toolActionLabel({ name: 'internal_probe' })).toBe('正在执行操作');
    expect(toolActionLabel(null)).toBe('');
  });

  it('measures elapsed time from the server stream start', () => {
    expect(elapsedLabel('2026-10-30T00:00:00.000Z', Date.parse('2026-10-30T00:00:12.000Z'))).toBe('12 秒');
    expect(elapsedLabel('2026-10-30T00:00:00.000Z', Date.parse('2026-10-30T00:00:00.400Z'))).toBe('');
    expect(elapsedLabel(null, Date.now())).toBe('');
  });
});
