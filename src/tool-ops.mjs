// 工具操作共享核心:成员工具(bus.executeTool)与 Panel 工具(panel.executePanelTool)
// 的重合逻辑收口在此,执行器只保留工具名分发与执行者差异(权限门禁、目标解析、锚点)。

/** 回复指向校验:只能回复发给自己、期待答复的 send,且答复对象必须是原请求发送者。 */
export function assertReplyTarget(store, groupId, replyTo, senderId, targetId) {
  const replyTarget = store.get('SELECT * FROM messages WHERE id=? AND group_id=?', replyTo, groupId);
  if (!replyTarget) throw new Error('回复的原消息不存在或不属于当前团队');
  if (replyTarget.kind !== 'send' || replyTarget.expects_reply !== 1) throw new Error('只能回复一条期待答复的消息');
  if (replyTarget.recipient !== senderId) throw new Error('不能回复不是发给自己的请求');
  if (replyTarget.sender !== targetId) throw new Error('回复对象必须是原请求的发送者');
}

/** 落一条带来源的正式消息:消息与 message_origins 同事务;无回合来源时不写 origins。 */
export function appendRoutedMessage(store, { groupId, senderId, targetId, kind, text, replyTo = null, expectsReply = false, origin = null }) {
  return store.transaction(() => {
    const value = store.append(groupId, senderId, targetId, kind, text, replyTo, expectsReply);
    if (origin) {
      store.run('INSERT INTO message_origins(message_id,turn_id,event_seq,call_id,native_call_id) VALUES(?,?,?,?,?)',
        value.id, origin.turnId ?? null, origin.eventSeq ?? null, origin.callId, origin.nativeCallId ?? null);
    }
    return value;
  });
}

/** 互动卡 kind/options 配对校验;详细约束在工具 schema,这里补跨字段规则。 */
export function assertAskCard(args) {
  if (args.kind === 'choice' && !Array.isArray(args.options)) throw new Error('choice 必须提供 options');
  if (args.kind === 'input' && args.options !== undefined) throw new Error('input 不接受 options');
}

export function askCardPayload(args) {
  return { kind: args.kind, text: args.text, ...(args.options ? { options: args.options } : {}) };
}

/** 共享消息读取:列表(after/limit/sender)与正文展开(messageId+hash)互斥,展开按 code point 范围取正文。 */
export function readSharedMessages(bus, { groupId, args, schema, resolveSenderId }) {
  if (args.messageId) {
    if (args.after !== undefined || args.limit !== undefined || args.sender !== undefined) {
      throw new Error('正文展开不能同时使用列表参数');
    }
    return bus.information.readBody({
      groupId,
      messageId: args.messageId,
      hash: args.hash,
      offset: args.offset ?? 0,
      bodyLimit: args.bodyLimit ?? 1024,
      schema,
    });
  }
  if (args.hash !== undefined || args.offset !== undefined || args.bodyLimit !== undefined) {
    throw new Error('hash、offset、bodyLimit 需要同时提供 messageId');
  }
  const senderId = resolveSenderId(args.sender);
  return bus.information.listMessages({
    groupId,
    after: args.after ?? 0,
    limit: args.limit ?? 50,
    senderId,
    schema,
  });
}
