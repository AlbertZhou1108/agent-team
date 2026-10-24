import { describe, expect, it } from 'vitest';
import type { MessageView } from '@/shared/models/view-types';
import type { TeamStream } from '@/shared/api/raw-types';
import { toStreamMessageViews } from './adapters';

const message: MessageView = {
  id: 'message-1',
  seq: 1,
  pairKey: 'agent:worker',
  senderName: 'Agent',
  recipientName: 'Worker',
  senderIsLead: true,
  senderIsUser: false,
  kind: 'send',
  text: 'durable',
  createdAt: '2026-10-24T00:00:00.000Z',
};

function stream(overrides: Partial<TeamStream> = {}): TeamStream {
  return {
    id: 'turn:call',
    groupId: 'team',
    endpointId: 'endpoint',
    memberId: 'agent',
    memberName: 'Agent',
    recipientName: 'Worker',
    pairKey: 'agent:worker',
    kind: 'message',
    messageKind: 'note',
    host: 'dsh',
    context: 'coordination',
    turnId: 'turn',
    text: 'draft',
    created: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:01.000Z',
    ...overrides,
  };
}

describe('stream message views', () => {
  it('keeps drafts pending and displays a completed message before cache sync', () => {
    const [draft] = toStreamMessageViews([], [stream()], '', 'agent');
    expect(draft).toMatchObject({
      message: { id: 'stream:turn:call', text: 'draft', kind: 'note' },
      pending: true,
    });

    const [completed] = toStreamMessageViews([], [stream({
      phase: 'complete',
      messageId: 'message-2',
      messageSeq: 2,
      text: 'persisted note',
    })], '', 'agent');
    expect(completed).toMatchObject({
      message: {
        id: 'message-2',
        seq: 2,
        text: 'persisted note',
        kind: 'note',
      },
      pending: false,
    });
  });

  it('deduplicates a durable row and respects the selected pair', () => {
    const completed = stream({
      phase: 'complete',
      messageId: message.id,
      messageSeq: message.seq,
      text: message.text,
    });
    expect(toStreamMessageViews([message], [completed], '', 'agent')).toEqual([]);
    expect(toStreamMessageViews(
      [],
      [stream({ pairKey: 'agent:other' })],
      'agent:worker',
      'agent',
    )).toEqual([]);
  });
});
