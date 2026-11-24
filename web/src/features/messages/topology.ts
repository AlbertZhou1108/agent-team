import type { MessageView } from '@/shared/models/view-types';
import type { StreamView } from './adapters';
import type { RunRow } from './run-rows';

export type TopologyMember = {
  name: string;
  active: boolean;
  phase?: RunRow['phase'];
};

export type TopologyEdge = {
  id: string;
  from: string;
  to: string;
  count: number;
  active: boolean;
};

export type TopologyFlight = {
  id: string;
  from: string;
  to: string;
  colorKey: string;
};

const NON_MEMBER_ACTORS = new Set(['系统', '用户', '用户指令']);

function isMemberActor(name: string | undefined): name is string {
  return Boolean(name && !NON_MEMBER_ACTORS.has(name));
}

function edgeKey(a: string, b: string) {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

export type MemberActivitySummary = {
  count: number;
  lastMessageId: string | null;
  lastSummary: string;
};

/**
 * 从当前运行行与会话消息派生参与拓扑展示的成员与活跃通信边。
 * 运行中的成员排在前面，其余按最近消息出现顺序补充；排除系统通知与用户指令。
 * 仅在两位成员之间正在进行通信（活跃流或飞行中纸飞机）时才生成连线，空闲时不画线。
 */
export function buildTopology(
  rows: RunRow[],
  messages: MessageView[],
  streams: StreamView[] = [],
  flights: TopologyFlight[] = [],
  maxMembers = 6,
): { members: TopologyMember[]; edges: TopologyEdge[] } {
  const memberMap = new Map<string, TopologyMember>();
  for (const row of rows) {
    if (!isMemberActor(row.name)) continue;
    if (!memberMap.has(row.name)) {
      memberMap.set(row.name, { name: row.name, active: true, phase: row.phase });
    }
  }

  // 从最新消息逆序补充近期有通信的成员，保持胶囊紧凑不溢出。
  for (let i = messages.length - 1; i >= 0 && memberMap.size < maxMembers; i -= 1) {
    const msg = messages[i]!;
    if (isMemberActor(msg.senderName) && !memberMap.has(msg.senderName)) {
      memberMap.set(msg.senderName, { name: msg.senderName, active: false });
    }
    if (memberMap.size >= maxMembers) break;
    if (isMemberActor(msg.recipientName) && !memberMap.has(msg.recipientName)) {
      memberMap.set(msg.recipientName, { name: msg.recipientName, active: false });
    }
  }

  const members = Array.from(memberMap.values());
  const visibleNames = new Set(members.map(m => m.name));
  const edgeMap = new Map<string, TopologyEdge>();

  const addActiveEdge = (from: string, to: string) => {
    if (from === to || !visibleNames.has(from) || !visibleNames.has(to)) return;
    const key = edgeKey(from, to);
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count += 1;
      existing.from = from;
      existing.to = to;
    } else {
      edgeMap.set(key, { id: key, from, to, count: 1, active: true });
    }
  };

  for (const stream of streams) {
    if (!stream.pending) continue;
    const { senderName, recipientName } = stream.message;
    if (isMemberActor(senderName) && isMemberActor(recipientName)) {
      addActiveEdge(senderName, recipientName);
    }
  }

  for (const flight of flights) {
    addActiveEdge(flight.from, flight.to);
  }

  return { members, edges: Array.from(edgeMap.values()) };
}

/**
 * 从已加载会话消息中按成员汇总收发条数，并提取该成员主动发出的最后一条消息摘要与 id。
 * 统一口径：仅记录成员作为发送方（senderName）发出的消息；从未发送过消息的成员不生成摘要与跳转目标。
 */
export function buildMemberActivitySummaries(
  messages: MessageView[],
): Record<string, MemberActivitySummary> {
  const counts = new Map<string, number>();
  const latest = new Map<string, { id: string; summary: string }>();

  for (const msg of messages) {
    const snippet = msg.text.replace(/\s+/g, ' ').trim();
    if (isMemberActor(msg.senderName)) {
      counts.set(msg.senderName, (counts.get(msg.senderName) ?? 0) + 1);
      const target = msg.recipientName ? `→ ${msg.recipientName}` : '';
      const summary = snippet ? `${target ? `${target}：` : ''}${snippet}` : target;
      if (summary) {
        latest.set(msg.senderName, { id: msg.id, summary });
      }
    }
    if (isMemberActor(msg.recipientName)) {
      counts.set(msg.recipientName, (counts.get(msg.recipientName) ?? 0) + 1);
    }
  }

  const result: Record<string, MemberActivitySummary> = {};
  for (const [name, count] of counts.entries()) {
    const sent = latest.get(name);
    result[name] = {
      count,
      lastMessageId: sent?.id ?? null,
      lastSummary: sent?.summary ?? '',
    };
  }
  return result;
}

/**
 * 仅在新增消息或新增流式回合时产生纸飞机飞行任务；
 * 已有流式消息的 token 增量更新不会重复触发。
 */
export function detectNewFlights(
  seenMessageIds: Set<string>,
  seenStreamIds: Set<string>,
  messages: MessageView[],
  streams: StreamView[],
  hydrated: boolean,
): TopologyFlight[] {
  const flights: TopologyFlight[] = [];

  for (const msg of messages) {
    if (seenMessageIds.has(msg.id)) continue;
    seenMessageIds.add(msg.id);
    if (!hydrated) continue;
    if (
      isMemberActor(msg.senderName)
      && isMemberActor(msg.recipientName)
      && msg.senderName !== msg.recipientName
    ) {
      flights.push({
        id: `msg:${msg.id}`,
        from: msg.senderName,
        to: msg.recipientName,
        colorKey: msg.senderName,
      });
    }
  }

  for (const stream of streams) {
    const key = stream.turnId ?? stream.message.id;
    if (seenStreamIds.has(key)) continue;
    seenStreamIds.add(key);
    if (!hydrated) continue;
    const { senderName, recipientName } = stream.message;
    if (
      isMemberActor(senderName)
      && isMemberActor(recipientName)
      && senderName !== recipientName
    ) {
      flights.push({
        id: `stream:${key}`,
        from: senderName,
        to: recipientName,
        colorKey: senderName,
      });
    }
  }

  return flights;
}

/** 折叠态：成员头像横向排列，虚线从头像顶部中心向上拱起。 */
export function buildCompactArcPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  span: number,
): string {
  const lift = Math.min(20, 10 + Math.max(1, span) * 4);
  const cy = Math.min(y1, y2) - lift;
  return `M ${x1} ${y1} C ${x1} ${cy} ${x2} ${cy} ${x2} ${y2}`;
}

/** 展开态：成员行纵向排列，虚线从右侧边缘锚点向右外拱。 */
export function buildExpandedCurvePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  span: number,
  maxBulge = 140,
): string {
  const bulge = Math.min(maxBulge, 44 + Math.max(1, span) * 26);
  const cx = Math.max(x1, x2) + bulge;
  return `M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`;
}
