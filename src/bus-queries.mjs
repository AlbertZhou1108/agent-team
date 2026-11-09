// 查询投影:侧栏概览、目录、会话绑定、运行中端点与未读的只读聚合。
import { SMART_PERFORMANCE_RULES, SMART_COST_RULES, DEFAULT_USER_MODEL_RULES } from './model-policy.mjs';
// 本模块不反向依赖 Bus;跨职责调用经 bus 引用。

// 会话统一投影:两种 owner 输出同一形状；Panel 协作会话沿用对外的 panel-coordination context。
function conversationView(conversation) {
  return {
    id: conversation.id,
    group_id: conversation.group_id,
    member_id: conversation.owner_kind === 'panel_agent' ? conversation.panel_agent_id : conversation.member_id,
    context: conversation.owner_kind === 'panel_agent' ? 'panel-coordination' : conversation.context,
    peer: conversation.peer ?? null,
    session: conversation.session,
  };
}

export class BusQueries {
  constructor(bus) {
    this.bus = bus;
  }
  groupSummary(groupId) {
    this.bus.store.group(groupId);
    return {
      communicationOpen: this.bus.collaboration.communicationOpen(groupId),
      unknown: this.bus.collaboration.unknown(groupId),
      runningCount: [...this.bus.running.values()].filter(item => item.endpoint.group_id === groupId).length,
    };
  }
  overview() {
    this.bus.ensurePanelBindings();
    const panelAgent = this.bus.panelAgent();
    return {
      groups: this.bus.store.all('SELECT * FROM groups ORDER BY created'),
      members: this.bus.store.all('SELECT * FROM members ORDER BY rowid'),
      panelAgent: panelAgent ? {
        id: panelAgent.id,
        name: panelAgent.name,
        host: panelAgent.host,
        model_provider: panelAgent.model_provider,
        model: panelAgent.model,
        reasoning_effort: panelAgent.reasoning_effort,
        created: panelAgent.created,
        updated: panelAgent.updated,
      } : null,
      panelTeams: this.bus.panelTeamViews(),
      actors: this.bus.store.actors().map(actor => actor.kind === 'member'
        ? { id: actor.id, name: actor.name }
        : {
          id: actor.id,
          name: actor.name,
          host: actor.host,
          model_provider: actor.model_provider ?? null,
          model: actor.model ?? null,
          reasoning_effort: actor.reasoning_effort ?? null,
        }),
      modelPolicy: this.bus.modelPolicy(),
      modelPolicyDefaults: {
        smart: {
          performance: SMART_PERFORMANCE_RULES,
          cost: SMART_COST_RULES,
        },
        user: DEFAULT_USER_MODEL_RULES,
      },
      groupStates: this.bus.store.all('SELECT id,state,charter,policy,allow_shell FROM groups'),
    };
  }
  queryDirectory() {
    const panelAgent = this.bus.panelAgent();
    return {
      members: this.bus.store.all('SELECT * FROM members ORDER BY rowid'),
      actors: [
        ...this.bus.store.all('SELECT id,name FROM members ORDER BY rowid'),
        ...this.bus.store.all('SELECT id,name FROM external_principals ORDER BY created'),
      ],
      panelAgent: panelAgent ? Object.fromEntries(['id','name','host','model_provider','model','reasoning_effort','created','updated'].map(key => [key, panelAgent[key]])) : null,
    };
  }
  queryDefaults() {
    return { smart: { performance: SMART_PERFORMANCE_RULES, cost: SMART_COST_RULES }, user: DEFAULT_USER_MODEL_RULES };
  }
  querySessions(groupId) {
    this.bus.store.group(groupId);
    this.bus.ensurePanelBindings();
    const endpoints = this.bus.store.conversationsForGroup(groupId)
      .filter(conversation => conversation.context !== 'private')
      .map(conversationView);
    const sessionBindings = this.bus.store.all(`SELECT b.conversation_id AS endpoint_id,b.session_key,b.session,b.session_updated AS updated FROM conversation_session_meta b
      WHERE b.session IS NOT NULL AND b.conversation_id IN (SELECT id FROM conversations WHERE group_id=? AND context!='private') ORDER BY b.conversation_id,b.session_key`, groupId);
    return { endpoints, sessionBindings };
  }
  querySession(groupId, endpointId) {
    this.bus.store.group(groupId);
    const conversation = this.bus.store.conversationById(endpointId);
    if (!conversation || conversation.group_id !== groupId) return null;
    if (conversation.context === 'private' || conversation.context === 'profile') return null;
    return conversationView(conversation);
  }
  queryRuntime(groupId) {
    if (groupId) this.bus.store.group(groupId);
    return [...this.bus.running.values()].filter(({ endpoint }) => endpoint.context !== 'private' && (!groupId || endpoint.group_id === groupId))
      .map(({ endpoint }) => ({ id: endpoint.id, group_id: endpoint.group_id, member_id: endpoint.member_id }));
  }
  // 私聊未读窗口：最近 200 条，只带归属信息不带正文。
  // 「本次启动之后的消息」由 panel/state.mjs 用 bootSeq 过滤，不在这里重复一套。
  queryUnread() {
    const agent = this.bus.panelAgent();
    if (!agent) return { messages: [], receipts: [] };
    const messages = this.bus.store.all("SELECT seq,role,active_team_id FROM (SELECT seq,role,active_team_id FROM panel_messages WHERE panel_agent_id=? AND context='private' ORDER BY seq DESC LIMIT 200) ORDER BY seq", agent.id);
    const receipts = this.bus.store.all('SELECT r.id,r.text,r.source_message_ids FROM team_request_receipts r JOIN team_requests q ON q.id=r.request_id WHERE q.panel_agent_id=? ORDER BY r.seq', agent.id)
      .map(row => { const sourceMessageIds = JSON.parse(row.source_message_ids); return { id: row.id, sourceMessageIds, isSourceCopy: sourceMessageIds.some(id => this.bus.store.get('SELECT text FROM messages WHERE id=?', id)?.text === row.text) }; });
    return { messages, receipts };
  }
  snapshot(groupId) {
    this.bus.ensurePanelBindings();
    const panelAgent = this.bus.panelAgent();
    const visibleEndpoints = this.bus.store.conversationsForGroup(groupId)
      .filter(conversation => conversation.owner_kind === 'member'
        || (panelAgent && conversation.panel_agent_id === panelAgent.id))
      .map(conversation => ({ ...conversationView(conversation), modelState: this.bus.store.endpointModelSummary(conversation.id) }));
    const endpointIds = new Set(visibleEndpoints.map(e => e.id));
    const sessionBindings = this.bus.store.all('SELECT conversation_id AS endpoint_id,session_key,session,session_updated AS updated FROM conversation_session_meta WHERE session IS NOT NULL ORDER BY conversation_id,session_key').filter(b => groupId === undefined || endpointIds.has(b.endpoint_id));
    return {
      ...this.bus.overview(),
      endpoints: visibleEndpoints,
      sessionBindings,
      // This is an observation of the processes currently owned by this bus, not stored business state.
      runningEndpoints: [...this.bus.running.values()]
        .filter(({ endpoint }) => endpoint.context !== 'private')
        .map(({ endpoint }) => endpoint.id),
      panelRunning: [...this.bus.running.values()]
        .filter(({ endpoint }) => String(endpoint.context).startsWith('panel-'))
        .map(({ endpoint, turnId, activeTeamId }) => ({ endpoint: endpoint.id, groupId: activeTeamId ?? endpoint.group_id ?? null, turnId })),
      panelUnknown: panelAgent ? this.bus.panelUnknown() : [],
      agentTasks: groupId ? this.bus.agentTasksView(groupId) : [],
    };
  }
}
