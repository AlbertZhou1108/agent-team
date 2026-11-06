// User-facing directive receipts share the existing trusted-user dispatch path.
// operation_records(scope='team-directive') 记录 指令编号 -> 触发消息 的幂等链接。
export class TeamDirectives {
  constructor(bus) {
    this.bus = bus;
  }
  publishOutput(turnId, text) {
    if (typeof text !== 'string' || !text.trim()) return;
    const s = this.bus.store;
    const replies = s.transaction(() => {
      const messages = s.all(`SELECT m.* FROM turn_inputs i JOIN messages m ON m.id=i.message_id
        JOIN operation_records d ON d.scope='team-directive' AND d.ref=m.id WHERE i.turn_id=? AND m.sender='user'`, turnId);
      const published = [];
      for (const input of messages) {
        // Only a response to this user or the same final text counts as a duplicate.
        // Messages sent to coworkers do not replace the user's answer.
        const existing = s.get(`SELECT m.id FROM messages m LEFT JOIN message_origins o ON o.message_id=m.id
          WHERE m.group_id=? AND m.sender=? AND (m.reply_to=? OR (o.turn_id=? AND m.text=?)) LIMIT 1`,
          input.group_id, input.recipient, input.id, turnId, text);
        if (existing) continue;
        const reply = s.append(input.group_id, input.recipient, 'user', 'send', text, input.id);
        s.run('INSERT INTO message_origins(message_id,turn_id,event_seq,call_id,native_call_id) VALUES(?,?,?,?,?)', reply.id, turnId, null, 'framework.final_output', null);
        published.push(reply);
      }
      return published;
    });
    for (const reply of replies) this.bus.emit('message', reply);
    return replies;
  }
  recoverOutputs() {
    const s = this.bus.store;
    // Recover persisted outputs after a restart, including outputs created before
    // user-facing replies were supported. Never invoke the model again.
    const rows = s.all(`SELECT DISTINCT h.turn_id,h.event FROM operation_records d
      JOIN turn_inputs i ON i.message_id=d.ref JOIN history h ON h.turn_id=i.turn_id
      JOIN turns t ON t.id=i.turn_id
      WHERE d.scope='team-directive' AND t.state='completed' AND json_extract(h.event,'$.type')='framework.output' ORDER BY h.seq`);
    for (const row of rows) this.publishOutput(row.turn_id, JSON.parse(row.event).text);
  }
  submit(groupId, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(k => !['text', 'operationId', 'controllerId'].includes(k))) throw new Error('指令参数无效');
    const { operationId, controllerId } = body;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 48000) throw new Error('消息须为 1–48000 字符');
    if (typeof operationId !== 'string' || !/^[\w-]{1,128}$/.test(operationId)) throw new Error('请求编号无效');
    if (typeof controllerId !== 'string' || !controllerId) throw new Error('缺少主 Agent 身份');
    const write = () => {
      this.bus.store.group(groupId);
      const previous = this.bus.store.get(`SELECT m.* FROM operation_records d JOIN messages m ON m.id=d.ref
        WHERE d.scope='team-directive' AND d.scope_id=? AND d.client_key=?`, groupId, operationId);
      if (previous) {
        if (previous.text !== text || previous.recipient !== controllerId) throw new Error('请求编号已用于不同内容或主 Agent');
        return this.receipt(groupId, previous.id, operationId);
      }
      if (this.bus.teamController(groupId).id !== controllerId) throw new Error('主 Agent 已变更，请刷新团队后重新发送');
      const { messageId } = this.bus.directive(groupId, text);
      this.bus.store.run("INSERT INTO operation_records(scope,scope_id,client_key,payload,ref,created) VALUES('team-directive',?,?,NULL,?,?)", groupId, operationId, messageId, new Date().toISOString());
      return this.receipt(groupId, messageId, operationId);
    };
    return this.bus.store.transaction(write);
  }
  receipt(groupId, messageId, operationId) {
    const s = this.bus.store;
    const message = s.get('SELECT id,seq,recipient,created FROM messages WHERE id=? AND group_id=?', messageId, groupId);
    const entry = s.get('SELECT o.accepted,o.error FROM attached a JOIN outbox o ON o.id=a.outbox_id WHERE a.message_id=?', messageId);
    const unknown = s.get(`SELECT t.id AS turn_id FROM turn_inputs i JOIN turns t ON t.id=i.turn_id
      WHERE i.message_id=? AND t.state='unknown'`, messageId);
    // Acceptance means the host received the input, never that the work succeeded.
    return { operationId, messageId, seq: message.seq, recipient: message.recipient, created: message.created,
      status: entry?.accepted ? 'delivered' : unknown ? 'unknown' : entry?.error ? 'failed' : 'queued',
      error: entry?.error ?? null };
  }
  list(groupId) {
    this.bus.store.group(groupId);
    return this.bus.store.all(`SELECT d.client_key AS operation_id,m.id FROM operation_records d JOIN messages m ON m.id=d.ref
      WHERE d.scope='team-directive' AND d.scope_id=? ORDER BY m.seq DESC LIMIT 50`, groupId)
      .map(r => this.receipt(groupId, r.id, r.operation_id));
  }
}
