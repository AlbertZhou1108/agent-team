import type { Member, MessageRow, TeamStream } from '@/shared/api/raw-types';
import type { MessageView } from '@/shared/models/view-types';

type ActorName = { id: string; name: string };

export function memberName(members: Member[], id: string, actors: ActorName[] = []) {
  if (id === 'system') return '系统';
  if (id === 'user') return '用户指令';
  return members.find(member => member.id === id)?.name
    ?? actors.find(actor => actor.id === id)?.name
    ?? id;
}

export function pairKey(sender: string, recipient: string) {
  return [sender, recipient].sort().join(':');
}

export function toMessageViews(
  rows: MessageRow[],
  members: Member[],
  actors: ActorName[] = [],
  controllerId?: string,
): MessageView[] {
  return rows.map(row => ({
    id: row.id,
    seq: row.seq,
    pairKey: pairKey(row.sender, row.recipient),
    senderName: memberName(members, row.sender, actors),
    recipientName: memberName(members, row.recipient, actors),
    senderIsLead: row.sender === controllerId
      || members.find(member => member.id === row.sender)?.role === 'lead',
    kind: row.kind,
    text: row.text,
    createdAt: row.created,
  }));
}

export function pairLabel(pair: string, members: Member[], actors: ActorName[] = []) {
  const [left, right] = pair.split(':');
  return `${memberName(members, left, actors)} ↔ ${memberName(members, right, actors)}`;
}

export function toStreamMessageViews(
  messages: MessageView[],
  streams: TeamStream[],
  selectedPair: string,
  controllerId?: string,
) {
  const persisted = new Set(messages.map(message => message.id));
  return streams
    .filter(stream => (
      stream.text
      && (!selectedPair || stream.pairKey === selectedPair)
      && (!stream.messageId || !persisted.has(stream.messageId))
    ))
    .map(stream => ({
      message: {
        id: stream.phase === 'complete' && stream.messageId
          ? stream.messageId
          : `stream:${stream.id}`,
        seq: stream.messageSeq ?? Number.MAX_SAFE_INTEGER,
        pairKey: stream.pairKey,
        senderName: stream.memberName,
        recipientName: stream.recipientName,
        senderIsLead: stream.memberId === controllerId,
        kind: stream.messageKind ?? ('send' as const),
        text: stream.text,
        createdAt: stream.created,
      } satisfies MessageView,
      pending: stream.phase !== 'complete' || !stream.messageId,
    }));
}
