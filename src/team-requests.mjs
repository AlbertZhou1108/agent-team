import { randomUUID } from 'node:crypto';

// Both entry points use TeamDirectives; this module owns private-source linkage.
export class TeamRequests {
  constructor(bus) {
    this.bus = bus;
    bus.store.db.exec(`
      CREATE TABLE IF NOT EXISTS team_requests(
        id TEXT PRIMARY KEY, panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,
        source_user_message_id TEXT NOT NULL REFERENCES panel_messages(id) ON DELETE CASCADE,
        source_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, call_id TEXT,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, controller_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        original_text TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL,
        UNIQUE(panel_agent_id,source_user_message_id,operation_id));
      CREATE TABLE IF NOT EXISTS team_request_receipts(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL REFERENCES team_requests(id) ON DELETE CASCADE, source_turn_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, text TEXT NOT NULL, source_message_ids TEXT NOT NULL,
        created TEXT NOT NULL,UNIQUE(request_id,operation_id));
      CREATE INDEX IF NOT EXISTS team_requests_agent ON team_requests(panel_agent_id,created);
      CREATE INDEX IF NOT EXISTS team_requests_group ON team_requests(group_id,created);
      CREATE INDEX IF NOT EXISTS team_request_receipts_request ON team_request_receipts(request_id,seq);
    `);
  }
  submit(session, agent, origin, { groupId, text, operationId }) {
    const s = this.bus.store;
    if (session.context !== 'private' || !origin.turnId) throw new Error('团队转交需要当前私人用户回合');
    const turn = s.get('SELECT t.*,t.conversation_id AS session_id FROM turns t WHERE t.id=? AND t.conversation_id=?', origin.turnId, session.id);
    const user = turn?.source_user_message_id && s.get("SELECT * FROM panel_messages WHERE id=? AND panel_agent_id=? AND role='user' AND context='private'", turn.source_user_message_id, agent.id);
    if (!user || turn.state !== 'running' || this.bus.running.get(session.id)?.turnId !== turn.id) throw new Error('团队转交缺少可信的原始用户消息');
    const previous = s.get('SELECT * FROM team_requests WHERE panel_agent_id=? AND source_user_message_id=? AND operation_id=?', agent.id, user.id, operationId);
    this.bus.requirePanelMain(agent.id, groupId);
    if (previous) {
      if (previous.group_id !== groupId || previous.text !== text || previous.controller_id !== this.bus.teamController(groupId).id) throw new Error('转交编号已用于不同内容或主控');
      return this.view(previous);
    }
    return s.transaction(() => {
      const id = randomUUID();
      const controller = this.bus.teamController(groupId);
      const directive = this.bus.teamDirectives.submit(groupId, { text, controllerId: controller.id, operationId: id }, { transaction: false });
      s.run('INSERT INTO team_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, agent.id, user.id, turn.id, origin.callId ?? null, groupId, controller.id, operationId, directive.messageId, user.text, text, new Date().toISOString());
      return this.view(s.get('SELECT * FROM team_requests WHERE id=?', id));
    });
  }
  publish(session, agent, origin, { requestId, sourceMessageIds, text, operationId }) {
    const s = this.bus.store;
    if (session.context !== 'coordination' || !origin.turnId) throw new Error('回执只能由团队协作回合发布');
    this.bus.requirePanelMain(agent.id, session.group_id);
    const request = s.get('SELECT * FROM team_requests WHERE id=? AND panel_agent_id=? AND group_id=?', requestId, agent.id, session.group_id);
    if (!request) throw new Error('请求不属于当前团队');
    const turn = s.get("SELECT t.*,t.conversation_id AS session_id FROM turns t WHERE t.id=? AND t.conversation_id=? AND t.state='running'", origin.turnId, session.id);
    if (!turn || this.bus.running.get(session.id)?.turnId !== turn.id) throw new Error('回执不属于当前执行回合');
    for (const id of sourceMessageIds) {
      if (!s.get('SELECT id FROM messages WHERE id=? AND group_id=?', id, session.group_id)) throw new Error('回执来源消息不属于当前团队');
    }
    const previous = s.get('SELECT * FROM team_request_receipts WHERE request_id=? AND operation_id=?', requestId, operationId);
    if (previous) {
      if (previous.text !== text || JSON.stringify(JSON.parse(previous.source_message_ids).slice(1)) !== JSON.stringify(sourceMessageIds)) throw new Error('回执编号已用于不同内容');
      return previous;
    }
    const receipt = s.transaction(() => {
      const message = s.append(session.group_id, agent.id, 'user', 'send', text, request.message_id);
      s.run('INSERT INTO message_origins(message_id,turn_id,event_seq,call_id,native_call_id) VALUES(?,?,?,?,?)', message.id, turn.id, null, origin.callId, origin.nativeCallId ?? null);
      const id = randomUUID();
      s.run('INSERT INTO team_request_receipts(id,request_id,source_turn_id,operation_id,text,source_message_ids,created) VALUES(?,?,?,?,?,?,?)', id, requestId, turn.id, operationId, text, JSON.stringify([message.id, ...sourceMessageIds]), new Date().toISOString());
      // 团队流的回执消息对私聊不可见(两套消息存储隔离);不在私聊落一条,
      // 用户扫私聊时感知不到主控已汇报——回执全文以主控口吻同步进私人会话。
      s.run('INSERT INTO panel_messages(id,panel_agent_id,context,role,text,active_team_id,created) VALUES(?,?,?,?,?,?,?)', randomUUID(), agent.id, 'private', 'assistant', text, session.group_id, new Date().toISOString());
      return { row: s.get('SELECT * FROM team_request_receipts WHERE id=?', id), message };
    });
    this.bus.emit('message', receipt.message);
    return receipt.row;
  }

  view(request) {
    return { ...request, delivery: this.bus.teamDirectives.receipt(request.group_id, request.message_id, request.id),
      receipts: this.bus.store.all('SELECT * FROM team_request_receipts WHERE request_id=? ORDER BY seq', request.id).map(row => ({ ...row, sourceMessageIds: JSON.parse(row.source_message_ids), isSourceCopy: JSON.parse(row.source_message_ids).some(id => this.bus.store.get('SELECT text FROM messages WHERE id=?', id)?.text === row.text) })) };
  }
  list(agentId, groupId = null) {
    return this.bus.store.all(`SELECT * FROM team_requests WHERE panel_agent_id=? ${groupId ? 'AND group_id=?' : ''} ORDER BY created`, ...[agentId, ...(groupId ? [groupId] : [])]).map(row => this.view(row));
  }
}
