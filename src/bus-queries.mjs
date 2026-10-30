// 查询投影:侧栏概览、目录、会话绑定、运行中端点与未读的只读聚合。
import { SMART_PERFORMANCE_RULES, SMART_COST_RULES, DEFAULT_USER_MODEL_RULES } from './model-policy.mjs';
// 本模块不反向依赖 Bus;跨职责调用经 bus 引用。

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
      panelTeams: panelAgent ? this.bus.panelTeamViews() : [],
      actors: [
        ...this.bus.store.all('SELECT id,name FROM members WHERE removed IS NULL'),
        ...(panelAgent ? [{
          id: panelAgent.id,
          name: panelAgent.name,
          host: panelAgent.host,
          model_provider: panelAgent.model_provider,
          model: panelAgent.model,
          reasoning_effort: panelAgent.reasoning_effort,
        }] : []),
      ],
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
      actors: this.bus.store.all('SELECT id,name FROM members ORDER BY rowid'),
      panelAgent: panelAgent ? Object.fromEntries(['id','name','host','model_provider','model','reasoning_effort','created','updated'].map(key => [key, panelAgent[key]])) : null,
    };
  }
  queryDefaults() {
    return { smart: { performance: SMART_PERFORMANCE_RULES, cost: SMART_COST_RULES }, user: DEFAULT_USER_MODEL_RULES };
  }
  querySessions(groupId) {
    this.bus.store.group(groupId);
    this.bus.ensurePanelBindings();
    const endpoints = [
      ...this.bus.store.all("SELECT id,group_id,member_id,context,peer,session FROM endpoints WHERE group_id=? AND context!='private'", groupId),
      ...this.bus.store.all("SELECT id,group_id,panel_agent_id AS member_id,context,NULL AS peer,session FROM panel_sessions WHERE group_id=? AND context='coordination'", groupId).map(row => ({ ...row, context: 'panel-coordination' })),
    ];
    const sessionBindings = this.bus.store.all(`SELECT b.endpoint_id,b.session_key,b.session,b.updated FROM endpoint_session_bindings b
      WHERE b.endpoint_id IN (SELECT id FROM endpoints WHERE group_id=? AND context!='private'
      UNION SELECT id FROM panel_sessions WHERE group_id=? AND context='coordination') ORDER BY b.endpoint_id,b.session_key`, groupId, groupId);
    return { endpoints, sessionBindings };
  }
  querySession(groupId, endpointId) {
    this.bus.store.group(groupId);
    return this.bus.store.get("SELECT id,group_id,member_id,context,peer,session FROM endpoints WHERE group_id=? AND id=? AND context NOT IN ('private','profile')", groupId, endpointId)
      ?? this.bus.store.get("SELECT id,group_id,panel_agent_id AS member_id,'panel-coordination' AS context,NULL AS peer,session FROM panel_sessions WHERE group_id=? AND id=? AND context='coordination'", groupId, endpointId);
  }
  queryRuntime(groupId) {
    if (groupId) this.bus.store.group(groupId);
    return [...this.bus.running.values()].filter(({ endpoint }) => endpoint.context !== 'private' && endpoint.context !== 'panel-private' && (!groupId || endpoint.group_id === groupId))
      .map(({ endpoint }) => ({ id: endpoint.id, group_id: endpoint.group_id, member_id: endpoint.member_id }));
  }
  queryUnread(current = false) {
    const agent = this.bus.panelAgent();
    if (!agent) return { messages: [], receipts: [] };
    const messages = this.bus.store.all("SELECT seq,role,active_team_id FROM (SELECT seq,role,active_team_id FROM panel_messages WHERE panel_agent_id=? AND context='private'" + (current ? ' AND seq>?' : '') + ' ORDER BY seq DESC LIMIT 200) ORDER BY seq', agent.id, ...(current ? [this.bus.panelBootSeq] : []));
    const receipts = this.bus.store.all('SELECT r.id,r.text,r.source_message_ids FROM team_request_receipts r JOIN team_requests q ON q.id=r.request_id WHERE q.panel_agent_id=?' + (current ? " AND r.seq>? AND q.group_id IN (SELECT id FROM groups WHERE state IS NULL OR state!='archived')" : '') + ' ORDER BY r.seq', agent.id, ...(current ? [this.bus.panelBootReceiptSeq] : []))
      .map(row => { const sourceMessageIds = JSON.parse(row.source_message_ids); return { id: row.id, sourceMessageIds, isSourceCopy: sourceMessageIds.some(id => this.bus.store.get('SELECT text FROM messages WHERE id=?', id)?.text === row.text) }; });
    return { messages: current ? messages.map(row => ({ ...row, active_team_id: null })) : messages, receipts };
  }
  snapshot(groupId) {
    this.bus.ensurePanelBindings();
    const panelAgent = this.bus.panelAgent();
    const endpoints = [
      ...this.bus.store.all("SELECT id,group_id,member_id,context,peer,session FROM endpoints WHERE context!='private'")
        .filter(endpoint => groupId === undefined || endpoint.group_id === groupId)
        .map(endpoint => ({ ...endpoint, modelState: this.bus.store.endpointModelSummary(endpoint.id) })),
      ...(panelAgent
        ? this.bus.store.all("SELECT id,group_id,panel_agent_id AS member_id,'panel-coordination' AS context,NULL AS peer,session FROM panel_sessions WHERE panel_agent_id=? AND context='coordination'", panelAgent.id)
          .filter(endpoint => groupId === undefined || endpoint.group_id === groupId)
          .map(endpoint => ({ ...endpoint, modelState: this.bus.store.endpointModelSummary(endpoint.id) }))
        : []),
    ];
    const visibleEndpoints = groupId === undefined ? endpoints : endpoints.filter(e => e.group_id === groupId);
    const endpointIds = new Set(visibleEndpoints.map(e => e.id));
    const sessionBindings = this.bus.store.all('SELECT endpoint_id,session_key,session,updated FROM endpoint_session_bindings ORDER BY endpoint_id,session_key').filter(b => groupId === undefined || endpointIds.has(b.endpoint_id));
    return {
      ...this.bus.overview(),
      endpoints: visibleEndpoints,
      sessionBindings,
      // This is an observation of the processes currently owned by this bus, not stored business state.
      runningEndpoints: [...this.bus.running.values()]
        .filter(({ endpoint }) => endpoint.context !== 'private' && endpoint.context !== 'panel-private')
        .map(({ endpoint }) => endpoint.id),
      panelRunning: [...this.bus.running.values()]
        .filter(({ endpoint }) => String(endpoint.context).startsWith('panel-'))
        .map(({ endpoint, turnId, activeTeamId }) => ({ endpoint: endpoint.id, groupId: activeTeamId ?? endpoint.group_id ?? null, turnId })),
      panelUnknown: panelAgent ? this.bus.panelUnknown() : [],
      agentTasks: groupId ? this.bus.agentTasksView(groupId) : [],
    };
  }
}
