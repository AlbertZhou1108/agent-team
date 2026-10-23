import type { Member, SessionEndpoint } from '@/shared/api/raw-types';

export interface ConversationPair {
  key: string;
  memberId: string;
  peerId: string;
  label: string;
}

export function isPairEndpoint(endpoint: SessionEndpoint): boolean {
  return endpoint.context === 'pair' || endpoint.context.startsWith('pair:');
}

/**
 * 双方会话遥测只支持群成员之间的 pair。
 * 对端为 Panel Agent 或已移除成员的 pair 端点不属于群成员会话，
 * 由主 Agent 协调视图与成员概览覆盖；这里不能把它们送进
 * `/api/telemetry/conversation`，否则服务端会返回“成员不属于该群”。
 */
export function buildConversationPairs(
  members: Member[],
  endpoints: SessionEndpoint[],
): ConversationPair[] {
  const active = new Map(
    members.filter(member => !member.removed).map(member => [member.id, member]),
  );
  const nameOf = (id: string) => active.get(id)?.name ?? id;
  const pairs = new Map<string, ConversationPair>();
  for (const endpoint of endpoints) {
    if (!isPairEndpoint(endpoint) || !endpoint.peer) continue;
    const member = active.get(endpoint.member_id);
    const peer = active.get(endpoint.peer);
    if (!member || !peer) continue;
    if (member.group_id !== endpoint.group_id || peer.group_id !== endpoint.group_id) continue;
    const [first, second] = [endpoint.member_id, endpoint.peer].sort();
    const key = `${first}:${second}`;
    if (pairs.has(key)) continue;
    pairs.set(key, {
      key,
      memberId: first,
      peerId: second,
      label: `${nameOf(first)} ↔ ${nameOf(second)}`,
    });
  }
  return [...pairs.values()];
}
