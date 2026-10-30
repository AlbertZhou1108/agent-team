import type { Member, MessageRow, PanelMessage, PanelStream, StreamPhase, StreamTool, TeamStream } from '@/shared/api/raw-types';
import type { MessageView } from '@/shared/models/view-types';

type ActorName = { id: string; name: string };

export type StreamView = {
  message: MessageView;
  pending: boolean;
  reasoning?: string;
  /** 回合标识:多条流(正文 + 工具草稿)按它汇总为一行运行状态。 */
  turnId?: string;
  toolCallId?: string;
  startedAt?: string | null;
  runPhase?: StreamPhase;
  tool?: StreamTool | null;
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
      // 运行中的空流也要保留:状态卡需要在首个 token 之前就说明有人正在处理。
      (stream.text || stream.reasoning || stream.phase !== 'complete')
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
      turnId: stream.turnId,
      toolCallId: stream.toolCallId,
      startedAt: stream.created,
      runPhase: stream.runPhase,
      tool: stream.tool ?? null,
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

function sameView(left: MessageView, right: MessageView) {
  return left.id === right.id
    && left.seq === right.seq
    && left.pairKey === right.pairKey
    && left.senderName === right.senderName
    && left.recipientName === right.recipientName
    && left.senderIsLead === right.senderIsLead
    && left.senderIsUser === right.senderIsUser
    && left.kind === right.kind
    && left.text === right.text
    && left.createdAt === right.createdAt;
}

/**
 * 复用内容未变的消息视图对象。列表每轮都会重建(轮询返回新数组、过滤器产出新数组),
 * 而消息 vnode 的 props 比较按引用短路:引用稳定时历史消息不会跟着流式输出重渲染。
 * 返回的数组在没有变化时保持原引用,连下游 v-for 的重建也一并省掉。
 */
export function reuseMessageViews(previous: MessageView[], next: MessageView[]): MessageView[] {
  if (!previous.length) return next;
  const existing = new Map(previous.map(view => [view.id, view]));
  let changed = previous.length !== next.length;
  const views = next.map((view, index) => {
    const old = existing.get(view.id);
    if (old && sameView(old, view)) {
      if (previous[index] !== old) changed = true;
      return old;
    }
    changed = true;
    return view;
  });
  return changed ? views : previous;
}

export function toPanelStreamViews(
  streams: Array<PanelStream | null | undefined>,
  {
    agentName,
    activeTeamId,
    running = false,
    runningSince = null,
  }: {
    agentName: string;
    activeTeamId: string | null;
    running?: boolean;
    runningSince?: string | null;
  },
): StreamView[] {
  const views: StreamView[] = [];
  for (const stream of streams) {
    if (!stream) continue;
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
      turnId: stream.turnId,
      startedAt: stream.created,
      runPhase: stream.runPhase,
      tool: stream.tool ?? null,
    });
  }
  // 宿主已受理但还没有任何流事件时补一条占位,时间锚点用服务端的回合创建时间。
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
        createdAt: runningSince ?? new Date().toISOString(),
      },
      pending: true,
      turnId: 'panel-agent-running',
      startedAt: runningSince ?? null,
      runPhase: 'accepted',
    });
  }
  return views;
}
