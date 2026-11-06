// User-facing directive receipts share the existing trusted-user dispatch path.
// operation_records(scope='team-directive') 记录 指令编号 -> 触发消息 的幂等链接。
import * as messagesAgg from './aggregates/messages.mjs';
import * as turnsAgg from './aggregates/turns.mjs';

export class TeamDirectives {
  constructor(bus) {
    this.bus = bus;
  }
  publishOutput(turnId, text) {
    if (typeof text !== 'string' || !text.trim()) return;
    const s = this.bus.store;
    const replies = s.transaction(() => {
      const messages = messagesAgg.directiveInputMessages(s, turnId);
      const published = [];
      for (const input of messages) {
        // Only a response to this user or the same final text counts as a duplicate.
        // Messages sent to coworkers do not replace the user's answer.
        const existing = messagesAgg.publishedDirectiveReply(s, {
          groupId: input.group_id,
          sender: input.recipient,
          replyTo: input.id,
          turnId,
          text,
        });
        if (existing) continue;
        const reply = messagesAgg.append(s, input.group_id, input.recipient, 'user', 'send', text, input.id);
        messagesAgg.insertOrigin(s, { messageId: reply.id, turnId, callId: 'framework.final_output' });
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
    const rows = turnsAgg.completedDirectiveOutputs(s);
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
      const previous = messagesAgg.directiveMessageByOperation(this.bus.store, { groupId, operationId });
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
    const message = messagesAgg.byIdInGroup(s, messageId, groupId);
    const entry = messagesAgg.deliveryStateForMessage(s, messageId);
    const unknown = turnsAgg.unknownTurnForMessage(s, messageId);
    // Acceptance means the host received the input, never that the work succeeded.
    return { operationId, messageId, seq: message.seq, recipient: message.recipient, created: message.created,
      status: entry?.accepted ? 'delivered' : unknown ? 'unknown' : entry?.error ? 'failed' : 'queued',
      error: entry?.error ?? null };
  }
  list(groupId) {
    this.bus.store.group(groupId);
    return messagesAgg.directiveOperations(this.bus.store, groupId)
      .map(r => this.receipt(groupId, r.id, r.operation_id));
  }
}
