// 遥测查询:对外只读查询入口(管理者会话/成员会话/协调/成员/能力)。
import { TelemetryQueryError } from './write.mjs';

function conversationSummary(summary) {
  const { executorTotals: _executorTotals, contextReference: _contextReference, ...rest } = summary;
  return rest;
}

export function managerConversation(telemetry, groupId, controller, memberId, options = {}) {
  if (typeof groupId !== 'string' || !groupId.trim() || typeof memberId !== 'string' || !memberId.trim()) {
    throw new TelemetryQueryError('缺少 group 或 member 参数');
  }
  const base = telemetry._base(groupId);
  if (controller?.kind !== 'panel_agent') {
    throw new TelemetryQueryError('当前主 Agent 不是 Panel Agent，请使用成员 ↔ 成员双方会话');
  }
  const member = telemetry.store.get('SELECT * FROM members WHERE id=? AND group_id=? AND removed IS NULL', memberId, groupId);
  if (!member) throw new TelemetryQueryError('成员不存在或已移除', 404);
  const range = telemetry._range(options.from, options.to);
  const manager = {
    kind: 'panel_agent',
    memberId: controller.id,
    name: controller.agent?.name ?? controller.name,
    host: controller.agent?.host ?? 'unknown',
  };
  const pairEndpoint = telemetry.store.get(
    "SELECT id FROM conversations WHERE member_id=? AND context=?",
    memberId,
    `pair:${controller.id}`,
  );
  const memberBatches = telemetry._batches(groupId, range)
    .filter(batch => batch.executor.kind === 'member'
      && batch.executor.memberId === memberId
      && pairEndpoint
      && batch.physicalSession.endpointId === pairEndpoint.id)
    .map(batch => {
      const view = { ...batch, side: 'member', outgoingMessages: [], involvement: null };
      Object.defineProperty(view, '_sessionMeta', { enumerable: false, value: batch._sessionMeta });
      return view;
    });
  const allManagerBatches = telemetry._batches(groupId).filter(batch => batch.executor.kind === 'panel_agent'
    && batch.executor.memberId === controller.id
    && batch.physicalSession.context === 'coordination');
  const managerBatches = [];
  for (const batch of allManagerBatches) {
    if (range.from && Date.parse(batch.startedAt) < Date.parse(range.from)) continue;
    if (range.to && Date.parse(batch.startedAt) >= Date.parse(range.to)) continue;
    const turn = telemetry._loadTurn('panel', batch.frameworkTurnId);
    if (!turn) continue;
    const outgoingMessages = telemetry._outgoingMessages(turn);
    const involvement = telemetry._involvement(turn, outgoingMessages, groupId, memberId);
    if (!involvement.involvedMemberIds.includes(memberId)) continue;
    const view = { ...batch, side: 'manager', outgoingMessages, involvement };
    Object.defineProperty(view, '_sessionMeta', { enumerable: false, value: batch._sessionMeta });
    managerBatches.push(view);
  }
  const sortedManagerBatches = managerBatches.sort((a, b) => telemetry._compareBatches(a, b));
  const sortedMemberBatches = memberBatches.sort((a, b) => telemetry._compareBatches(a, b));
  const union = [...sortedMemberBatches, ...sortedManagerBatches]
    .sort((a, b) => telemetry._compareBatches(a, b));
  const paged = telemetry._managerPage(union, options);
  const involvedMemberIds = [...new Set(sortedManagerBatches.flatMap(batch => batch.involvement.involvedMemberIds))].sort();
  const sessionIds = new Set(sortedManagerBatches.map(batch => batch.physicalSession.instanceId));
  const managerSessions = telemetry._sessions(allManagerBatches.filter(batch => sessionIds.has(batch.physicalSession.instanceId)));
  const memberBatchIds = sortedMemberBatches.map(batch => batch.batchId);
  const managerBatchIds = sortedManagerBatches.map(batch => batch.batchId);
  const exclusiveBatchIds = sortedManagerBatches.filter(batch => batch.involvement.exclusiveToMember).map(batch => batch.batchId);
  const sharedBatchIds = sortedManagerBatches.filter(batch => batch.involvement.sharedWithOtherMembers).map(batch => batch.batchId);
  return {
    ...base,
    range,
    member: { memberId: member.id, name: member.name, host: member.host },
    manager,
    memberSide: {
      totals: telemetry._sumBatches(sortedMemberBatches),
      contextReference: sortedMemberBatches.length ? telemetry._latestContext(sortedMemberBatches) : telemetry._managerEmptyContext(),
      coverage: telemetry._coverage(sortedMemberBatches),
      batchCount: sortedMemberBatches.length,
      physicalSessions: telemetry._sessions(sortedMemberBatches),
    },
    managerSide: {
      involvementTotals: telemetry._sumBatches(sortedManagerBatches),
      exclusiveBatchIds,
      sharedBatchIds,
      involvedMemberIds,
      batchCount: sortedManagerBatches.length,
      physicalSessions: managerSessions,
      contextReference: sortedManagerBatches.length ? telemetry._latestContext(sortedManagerBatches) : telemetry._managerEmptyContext(),
      coverage: telemetry._coverage(sortedManagerBatches),
    },
    batches: paged.page,
    nextCursor: paged.nextCursor,
    summary: {
      memberBatchIds,
      managerBatchIds,
      exclusiveManagerBatchIds: exclusiveBatchIds,
      sharedManagerBatchIds: sharedBatchIds,
      note: '管理者侧为相关性视图：共享批次整批只计一次，禁止拆分或与成员侧/协调总量相加',
    },
    provenance: telemetry._provenance([...sortedMemberBatches, ...sortedManagerBatches]),
  };
}

export function conversation(telemetry, groupId, memberId, peerId, options = {}) {
  const base = telemetry._base(groupId);
  const member = telemetry.store.get('SELECT * FROM members WHERE id=? AND removed IS NULL', memberId);
  const peer = telemetry.store.get('SELECT * FROM members WHERE id=? AND removed IS NULL', peerId);
  if (!member || !peer || member.group_id !== groupId || peer.group_id !== groupId) throw new TelemetryQueryError('成员不属于该群', 404);
  if (memberId === peerId) throw new TelemetryQueryError('会话双方不能是同一成员');
  const range = telemetry._range(options.from, options.to);
  const endpoints = [
    telemetry.store.get("SELECT * FROM conversations WHERE member_id=? AND context=?", memberId, `pair:${peerId}`),
    telemetry.store.get("SELECT * FROM conversations WHERE member_id=? AND context=?", peerId, `pair:${memberId}`),
  ].filter(Boolean);
  const endpointIds = new Set(endpoints.map(endpoint => endpoint.id));
  const allBatches = telemetry._batches(groupId, range).filter(batch => endpointIds.has(batch.physicalSession.endpointId));
  const paged = telemetry._page(allBatches, options);
  const participants = [member, peer].map(item => ({ memberId: item.id, name: item.name, host: item.host }));
  const executors = [member, peer].map(item => {
    const batches = allBatches.filter(batch => batch.executor.memberId === item.id);
    return {
      executor: { kind: 'member', memberId: item.id, name: item.name, host: item.host },
      physicalSessions: telemetry._sessions(batches),
      batchCount: batches.length,
      totals: telemetry._sumBatches(batches),
      contextReference: telemetry._latestContext(batches),
      coverage: telemetry._coverage(batches),
    };
  });
  return {
    ...base,
    range,
    conversation: {
      participantIds: [memberId, peerId],
      participants,
    },
    executors,
    batches: paged.page,
    nextCursor: paged.nextCursor,
    summary: conversationSummary(telemetry._summary(allBatches)),
    provenance: telemetry._provenance(allBatches),
  };
}

export function coordination(telemetry, groupId, controller, options = {}) {
  const base = telemetry._base(groupId);
  const range = telemetry._range(options.from, options.to);
  const endpointIds = new Set();
  if (controller?.kind === 'member') {
    for (const endpoint of telemetry.store.all("SELECT id FROM conversations WHERE member_id=? AND context='coordination'", controller.id)) endpointIds.add(endpoint.id);
  } else if (controller?.kind === 'panel_agent') {
    for (const session of telemetry.store.all("SELECT id FROM conversations WHERE panel_agent_id=? AND group_id=? AND context='coordination'", controller.id, groupId)) endpointIds.add(session.id);
  }
  const allBatches = telemetry._batches(groupId, range).filter(batch => endpointIds.has(batch.physicalSession.endpointId));
  const paged = telemetry._page(allBatches, options);
  const summary = telemetry._summary(allBatches);
  const executor = controller?.kind === 'member'
    ? { kind: 'member', memberId: controller.member.id, name: controller.member.name, host: controller.member.host }
    : controller?.kind === 'panel_agent'
      ? { kind: 'panel_agent', memberId: controller.agent.id, name: controller.agent.name, host: controller.agent.host }
      : null;
  return {
    ...base,
    range,
    coordination: executor ? { executor, physicalSessions: telemetry._sessions(allBatches) } : null,
    batches: paged.page,
    nextCursor: paged.nextCursor,
    summary,
    provenance: telemetry._provenance(allBatches),
  };
}

export function members(telemetry, groupId, options = {}) {
  const base = telemetry._base(groupId);
  const range = telemetry._range(options.from, options.to);
  const allBatches = telemetry._batches(groupId, range);
  const members = telemetry.store.all('SELECT * FROM members WHERE group_id=? AND removed IS NULL ORDER BY rowid', groupId);
  const panelAgent = telemetry.store.panelAgent();
  const entries = members.map(member => ({ kind: 'member', id: member.id, name: member.name, host: member.host }));
  if (panelAgent) entries.push({ kind: 'panel_agent', id: panelAgent.id, name: panelAgent.name, host: panelAgent.host });
  const memberRows = entries.map(entry => {
    const batches = allBatches.filter(batch => batch.executor.kind === entry.kind && batch.executor.memberId === entry.id);
    const physicalSessions = telemetry._sessions(batches);
    return {
      executor: { kind: entry.kind, memberId: entry.id, name: entry.name, host: entry.host },
      physicalSessions,
      physicalSessionCount: physicalSessions.length,
      batchCount: batches.length,
      totals: telemetry._sumBatches(batches),
      contextReference: telemetry._latestContext(batches),
      coverage: telemetry._coverage(batches),
    };
  });
  return {
    ...base,
    range,
    members: memberRows,
    sourceAnalysis: {
      note: '仅按消息来源分析，合并批次不拆分；不得与执行归属总量相加',
      actors: telemetry._sourceSubtotals(allBatches),
      mergedBatchIds: allBatches.filter(batch => batch.inputBatch.merge.merged).map(batch => batch.batchId),
      sharedSourceBatchIds: allBatches.filter(batch => batch.inputBatch.merge.sharedSources).map(batch => batch.batchId),
    },
    provenance: telemetry._provenance(allBatches),
  };
}

export function capabilities(telemetry, groupId, controllers = []) {
  const base = telemetry._base(groupId);
  const hosts = new Set(telemetry.store.all('SELECT DISTINCT host FROM members WHERE group_id=? AND removed IS NULL', groupId).map(row => row.host));
  const panelAgent = telemetry.store.panelAgent();
  if (panelAgent) hosts.add(panelAgent.host);
  for (const controller of controllers) if (controller?.host) hosts.add(controller.host);
  return {
    ...base,
    hosts: [...hosts].sort().map(host => {
      const declaration = telemetry._capabilitiesForHost(host);
      return { host: declaration.host, metrics: declaration.metrics };
    }),
  };
}
