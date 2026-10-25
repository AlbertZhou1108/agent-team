import type { Member, MessageRow, PanelMessage, PanelStream, TeamStream } from '@/shared/api/raw-types';
import type { MessageView } from '@/shared/models/view-types';

type ActorName = { id: string; name: string };

export type StreamView = {
  message: MessageView;
  pending: boolean;
  reasoning?: string;
};

export function memberName(members: Member[], id: string, actors: ActorName[] = []) {
  if (id === 'system') return '系统';
  if (id === 'user') return '用户';
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
    // 用户发给主 Agent 的消息保持「用户指令」语义；用户↔成员会话中的答复显示「用户」。
    senderName: row.sender === 'user' && members.find(member => member.id === row.recipient)?.role === 'lead'
      ? '用户指令'
      : memberName(members, row.sender, actors),
    recipientName: memberName(members, row.recipient, actors),
    senderIsLead: row.sender === controllerId
      || members.find(member => member.id === row.sender)?.role === 'lead',
    senderIsUser: row.sender === 'user',
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
): StreamView[] {
  const persisted = new Set(messages.map(message => message.id));
  return streams
    .filter(stream => (
      (stream.text || stream.reasoning)
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
        senderIsUser: false,
        kind: stream.messageKind ?? ('send' as const),
        text: stream.text,
        createdAt: stream.created,
      } satisfies MessageView,
      pending: stream.phase !== 'complete' || !stream.messageId,
      reasoning: stream.reasoning,
    }));
}

export const PANEL_PAIR_KEY = 'panel';

export function toPanelMessageViews(rows: PanelMessage[], agentName: string): MessageView[] {
  return rows.map(row => ({
    id: row.id,
    seq: row.seq,
    pairKey: PANEL_PAIR_KEY,
    senderName: row.role === 'user' ? '用户' : row.role === 'system' ? '系统' : agentName,
    recipientName: row.role === 'user' ? agentName : '用户',
    senderIsLead: false,
    senderIsUser: row.role === 'user',
    kind: row.role === 'system' ? 'system' : 'send',
    text: row.text,
    createdAt: row.created,
  }));
}

export function toPanelStreamViews(
  streams: Array<PanelStream | null | undefined>,
  { agentName, activeTeamId, running = false }: { agentName: string; activeTeamId: string | null; running?: boolean },
): StreamView[] {
  const views: StreamView[] = [];
  for (const stream of streams) {
    if (!stream || (!stream.text && !stream.reasoning)) continue;
    if (stream.activeTeamId !== (activeTeamId || null)) continue;
    views.push({
      message: {
        id: `stream:${stream.turnId}`,
        seq: Number.MAX_SAFE_INTEGER,
        pairKey: PANEL_PAIR_KEY,
        senderName: agentName,
        recipientName: '用户',
        senderIsLead: false,
        senderIsUser: false,
        kind: 'send',
        text: stream.text,
        createdAt: stream.created,
      },
      pending: true,
      reasoning: stream.reasoning,
    });
  }
  if (!views.length && running) {
    views.push({
      message: {
        id: 'panel-agent-running',
        seq: Number.MAX_SAFE_INTEGER,
        pairKey: PANEL_PAIR_KEY,
        senderName: agentName,
        recipientName: '用户',
        senderIsLead: false,
        senderIsUser: false,
        kind: 'send',
        text: '',
        createdAt: new Date().toISOString(),
      },
      pending: true,
    });
  }
  return views;
}
