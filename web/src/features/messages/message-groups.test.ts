import { describe, expect, it } from 'vitest';
import { buildMessageGroups, isSystemStack } from './message-groups';
import type { MessageView } from '@/shared/models/view-types';

function view(partial: Partial<MessageView> & { id: string; senderName: string }): MessageView {
  return {
    seq: 1,
    pairKey: 'a:b',
    recipientName: '主控',
    senderIsLead: false,
    senderIsUser: false,
    kind: 'send',
    text: '内容',
    createdAt: '2026-10-25T00:00:00.000Z',
    ...partial,
  };
}

describe('buildMessageGroups', () => {
  it('merges consecutive messages from the same sender into one run', () => {
    const groups = buildMessageGroups([
      view({ id: '1', senderName: '演示甲' }),
      view({ id: '2', senderName: '演示甲' }),
      view({ id: '3', senderName: '演示甲' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'run', sender: '演示甲→主控' });
    expect((groups[0] as { messages: MessageView[] }).messages.map(m => m.id)).toEqual(['1', '2', '3']);
  });

  it('splits runs when the sender alternates', () => {
    const groups = buildMessageGroups([
      view({ id: '1', senderName: '演示甲' }),
      view({ id: '2', senderName: '演示乙' }),
      view({ id: '3', senderName: '演示甲' }),
    ]);
    expect(groups.map(group => group.kind)).toEqual(['run', 'run', 'run']);
    expect(groups.map(group => (group as { sender?: string }).sender)).toEqual(['演示甲→主控', '演示乙→主控', '演示甲→主控']);
  });

  it('does not merge fan-out messages to different recipients from one sender', () => {
    const groups = buildMessageGroups([
      view({ id: '1', senderName: '欧鲸鲸', recipientName: '演示甲' }),
      view({ id: '2', senderName: '欧鲸鲸', recipientName: '演示乙' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'fanout' });
    expect((groups[0] as { messages: MessageView[] }).messages.map(m => m.recipientName)).toEqual(['演示甲', '演示乙']);
  });

  it('keeps fan-out only for identical text to different recipients', () => {
    const groups = buildMessageGroups([
      view({ id: '1', senderName: '欧鲸鲸', recipientName: '演示甲', text: '相同指令' }),
      view({ id: '2', senderName: '欧鲸鲸', recipientName: '演示乙', text: '相同指令' }),
      view({ id: '3', senderName: '欧鲸鲸', recipientName: '演示甲', text: '不同的后续内容' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ kind: 'fanout' });
    expect((groups[0] as { messages: MessageView[] }).messages).toHaveLength(2);
    expect(groups[1]).toMatchObject({ kind: 'run' });
  });

  it('does not treat repeated identical messages to the same recipient as fan-out', () => {
    const groups = buildMessageGroups([
      view({ id: '1', senderName: '欧鲸鲸', recipientName: '演示甲', text: '重发' }),
      view({ id: '2', senderName: '欧鲸鲸', recipientName: '演示甲', text: '重发' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'run' });
  });

  it('keeps user messages in their own runs and groups consecutive ones', () => {
    const groups = buildMessageGroups([
      view({ id: '1', senderName: '用户', senderIsUser: true }),
      view({ id: '2', senderName: '用户', senderIsUser: true }),
      view({ id: '3', senderName: '演示甲' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ kind: 'run', sender: '用户→主控' });
    expect(groups[1]).toMatchObject({ kind: 'run', sender: '演示甲→主控' });
  });

  it('collects consecutive system messages into a stack and breaks runs', () => {
    const groups = buildMessageGroups([
      view({ id: '1', senderName: '演示甲' }),
      view({ id: '2', senderName: '系统', kind: 'system' }),
      view({ id: '3', senderName: '系统', kind: 'system' }),
      view({ id: '4', senderName: '演示甲' }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ kind: 'run' });
    expect(groups[1]).toMatchObject({ kind: 'system' });
    expect(groups[2]).toMatchObject({ kind: 'run' });
    expect(isSystemStack(groups[1]!)).toBe(true);
  });

  it('renders a lone system message as a non-stacked single group', () => {
    const groups = buildMessageGroups([
      view({ id: '1', senderName: '系统', kind: 'system' }),
      view({ id: '2', senderName: '演示甲' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(isSystemStack(groups[0]!)).toBe(false);
  });

  it('keeps notes independent even when the same sender repeats', () => {
    const groups = buildMessageGroups([
      view({ id: '1', senderName: '演示甲', kind: 'note' }),
      view({ id: '2', senderName: '演示甲', kind: 'note' }),
    ]);
    expect(groups.map(group => group.kind)).toEqual(['single', 'single']);
  });

  it('can disable system stacking for panel-style feeds', () => {
    const groups = buildMessageGroups(
      [
        view({ id: '1', senderName: '系统', kind: 'system' }),
        view({ id: '2', senderName: '系统', kind: 'system' }),
      ],
      { groupSystemMessages: false },
    );
    expect(groups).toHaveLength(2);
    expect(isSystemStack(groups[0]!)).toBe(false);
  });
});
