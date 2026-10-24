import { describe, expect, it } from 'vitest';
import { buildTurns, uniqueHistoryRows } from './reducer';
import type { HistoryRow } from '@/shared/api/raw-types';

function row(seq: number, turn: string, event: unknown, endpoint = 'endpoint'): HistoryRow {
  return {
    seq,
    endpoint_id: endpoint,
    event: JSON.stringify(event),
    created: new Date(seq * 1000).toISOString(),
    turn_id: turn,
  };
}

describe('buildTurns', () => {
  it('merges codex reasoning deltas and framework tool call/result', () => {
    const turns = buildTurns([
      row(1, 't1', { type: 'input', text: 'go' }),
      row(2, 't1', {
        method: 'item/reasoning/textDelta',
        params: { itemId: 'reason-1', delta: 'first ' },
      }),
      row(3, 't1', {
        method: 'item/reasoning/textDelta',
        params: { itemId: 'reason-1', delta: 'second' },
      }),
      row(4, 't1', {
        method: 'item/completed',
        params: { item: { type: 'reasoning', id: 'reason-1', content: ['first second'] } },
      }),
      row(5, 't1', {
        type: 'framework.tool_call',
        callId: 'call-1',
        name: 'read',
        args: { after: 0 },
      }),
      row(6, 't1', {
        type: 'framework.tool_result',
        callId: 'call-1',
        result: { messages: [] },
      }),
      row(7, 't1', { type: 'framework.output', text: 'done' }),
    ], { hosts: { endpoint: 'codex' } });

    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe('completed');
    expect(turns[0].steps.filter(step => step.kind === 'reasoning')).toHaveLength(1);
    expect(turns[0].steps.find(step => step.kind === 'reasoning')?.summary).toBe('first second');
    expect(turns[0].steps.filter(step => step.kind === 'tool')).toHaveLength(1);
    expect(turns[0].steps.find(step => step.kind === 'tool')?.status).toBe('success');
  });

  it('maps claude thinking and ignores token accounting noise', () => {
    const turns = buildTurns([
      row(1, 't1', {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'th' } },
      }),
      row(2, 't1', {
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'inspect files' }] },
      }),
      row(3, 't1', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 }),
      row(4, 't1', { type: 'result', subtype: 'success', is_error: false, result: 'done' }),
      row(5, 't1', { type: 'framework.output', text: 'done' }),
    ], { hosts: { endpoint: 'claude' } });

    expect(turns[0].steps.map(step => step.kind)).toEqual(['reasoning', 'checkpoint', 'output']);
    expect(turns[0].steps[0].summary).toBe('inspect files');
  });

  it('maps dsh thinking, tool errors and turn completion', () => {
    const turns = buildTurns([
      row(1, 't1', { type: 'framework.reasoning.delta', turn: 1, step: 1, text: 'th' }),
      row(2, 't1', { type: 'framework.text.delta', turn: 1, step: 1, text: 'live' }),
      row(3, 't1', { type: 'thinking', text: 'try tool' }),
      row(4, 't1', {
        type: 'framework.tool_call',
        name: 'send',
        callId: 'call-1',
        args: { to: 'missing', text: 'x' },
      }),
      row(5, 't1', { type: 'framework.tool_result', callId: 'call-1', error: 'not found' }),
      row(6, 't1', { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }),
      row(7, 't1', { type: 'framework.output', text: 'handled' }),
    ], { hosts: { endpoint: 'dsh' } });

    expect(turns[0].status).toBe('completed');
    expect(turns[0].steps.filter(step => step.kind === 'reasoning')).toHaveLength(1);
    expect(turns[0].steps.find(step => step.kind === 'tool')?.status).toBe('error');
    expect(turns[0].steps.find(step => step.kind === 'tool')?.detail).toBe('not found');
  });

  it('preserves unknown and malformed events', () => {
    const turns = buildTurns([
      row(1, 't1', { method: 'future/event', params: {} }),
      {
        seq: 2,
        endpoint_id: 'endpoint',
        event: '{not-json',
        created: new Date().toISOString(),
        turn_id: 't1',
      },
    ], { hosts: { endpoint: 'codex' } });

    expect(turns[0].steps.filter(step => step.kind === 'unknown')).toHaveLength(2);
  });

  it('is idempotent and merges tool calls split across pages', () => {
    const call = row(199, 't1', {
      type: 'framework.tool_call',
      name: 'read',
      callId: 'call-1',
      args: {},
    });
    const result = row(201, 't1', {
      type: 'framework.tool_result',
      callId: 'call-1',
      result: { ok: true },
    });

    const once = buildTurns(uniqueHistoryRows([call, result]));
    const twice = buildTurns(uniqueHistoryRows([call, result, call, result]));
    expect(once).toEqual(twice);
    expect(once[0].steps).toHaveLength(1);
    expect(once[0].steps[0].sourceEvents).toEqual([199, 201]);
  });
});
