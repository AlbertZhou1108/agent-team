// messages 聚合:消息本体、来源(message_origins)与投递状态(attached/outbox)的
// 不变式边界。业务模块只通过本模块读这些表,不再各自拼 messages/outbox/attached 的 SQL;
// 分析型查询仍可直接用 store.all。所有函数接收 store,不持有全局状态。
//
// 不变式:
// - send 发给非 user 的消息才需要投递(awaiting=1),note/system 不参与 pending 扫描;
// - expects_reply 只对 send 生效(写入值的推导在 store.append,这里只转发表面);
// - 消息进入 attached 后 awaiting 必须清零(清零发生在 store.prepare 的事务内);
// - 一条消息同时只属于一个 outbox 行(attached.message_id 是主键)。

/**
 * 聚合层未逐行标注 JSDoc;store 为 Store 实例,查询返回的行形状由 SQL 决定。
 * @typedef {any} StoreLike
 */

/** 新建消息的唯一聚合入口:awaiting/expects_reply 的推导由 store.append 承担。 */
/** @param {StoreLike} store @param {string} groupId @param {string} sender @param {string} recipient @param {string} kind @param {string} text @param {string|null} [replyTo] @param {boolean} [expectsReply] */
export function append(store, groupId, sender, recipient, kind, text, replyTo = null, expectsReply = false) {
  return store.append(groupId, sender, recipient, kind, text, replyTo, expectsReply);
}

/** 按消息 id 读取(message 主键唯一)。 */
/** @param {StoreLike} store @param {string} id */
export function byId(store, id) {
  return store.get('SELECT * FROM messages WHERE id=?', id) ?? null;
}

/** 按「消息 id + 所属团队」读取:跨团队的消息视为不存在。 */
/** @param {StoreLike} store @param {string} id @param {string} groupId */
export function byIdInGroup(store, id, groupId) {
  const row = byId(store, id);
  return row && row.group_id === groupId ? row : null;
}

/** @param {StoreLike} store @param {string} id */
export function senderOf(store, id) {
  return byId(store, id)?.sender ?? null;
}

/** @param {StoreLike} store @param {string} id */
export function textOf(store, id) {
  return byId(store, id)?.text;
}

/** @param {StoreLike} store @param {string} id @param {string} groupId */
export function existsInGroup(store, id, groupId) {
  return Boolean(byIdInGroup(store, id, groupId));
}

/** 回复指向校验用:返回原消息行,不存在或不属于该团队时为 null。 */
/** @param {StoreLike} store @param {string} replyTo @param {string} groupId */
export function replyTarget(store, replyTo, groupId) {
  return byIdInGroup(store, replyTo, groupId);
}

/** 消息是否已进入投递队列(attached)。 */
/** @param {StoreLike} store @param {string} messageId */
export function isAttached(store, messageId) {
  return Boolean(store.get('SELECT 1 FROM attached WHERE message_id=?', messageId));
}

/** 待投递消息扫描(awaiting 事实),由 store 的 pending 查询承担。 */
/** @param {StoreLike} store */
export function pending(store) {
  return store.pending();
}

/** @param {StoreLike} store @param {string} conversationId */
export function hasPendingDelivery(store, conversationId) {
  return store.hasPendingDelivery(conversationId);
}

/** 把待投递消息并入 outbox/attached,并在同一事务里清零 awaiting。 */
/** @param {StoreLike} store @param {any} conversation @param {any} message @param {boolean} canBatch */
export function prepareDelivery(store, conversation, message, canBatch) {
  return store.prepareDelivery(conversation, message, canBatch);
}

/** 宿主已接受输入:accepted 表示收到输入,不表示工作成功。 */
/** @param {StoreLike} store @param {any} entry @param {boolean} accepted */
export function markDeliveryAccepted(store, entry, accepted) {
  return store.setDeliveryAccepted(entry, accepted);
}

/** @param {StoreLike} store @param {any} entry @param {any} error */
export function setDeliveryError(store, entry, error) {
  return store.setDeliveryError(entry, error);
}

/** @param {StoreLike} store @param {any} entry */
export function deliveryAccepted(store, entry) {
  return store.deliveryAccepted(entry);
}

/** 团队级待投递守卫:任一未接受/未失败的 outbox 行都阻止控制者切换。 */
/** @param {StoreLike} store @param {string} groupId */
export function hasPendingDeliveryForGroup(store, groupId) {
  return Boolean(store.get(
    'SELECT 1 FROM outbox WHERE accepted IS NULL AND error IS NULL AND conversation_id IN (SELECT id FROM conversations WHERE group_id=?)',
    groupId,
  ));
}

/** /retry 语义:只清 error,保留 accepted 与 payload,不重放已接受输入。 */
/** @param {StoreLike} store @param {string} groupId */
export function resetDeliveryErrorsForGroup(store, groupId) {
  return store.run(
    'UPDATE outbox SET error=NULL WHERE accepted IS NULL AND conversation_id IN (SELECT id FROM conversations WHERE group_id=?)',
    groupId,
  );
}

/** 成员被移除时,其收件消息不再需要投递。 */
/** @param {StoreLike} store @param {string} recipientId */
export function clearAwaitingForRecipient(store, recipientId) {
  return store.run('UPDATE messages SET awaiting=0 WHERE recipient=? AND awaiting=1', recipientId);
}

/** 成员被移除时丢弃其未接受的投递队列;消息与回合历史保留。 */
/** @param {StoreLike} store @param {string} memberId */
export function discardPendingDeliveriesForMember(store, memberId) {
  return store.run(
    'DELETE FROM outbox WHERE accepted IS NULL AND conversation_id IN (SELECT id FROM conversations WHERE member_id=?)',
    memberId,
  );
}

/** 来源标注:消息与 message_origins 一对一;无出处的消息不写行。 */
/** @param {StoreLike} store @param {{ messageId: string, turnId?: string|null, eventSeq?: number|null, callId: string, nativeCallId?: string|null }} input */
export function insertOrigin(store, { messageId, turnId = null, eventSeq = null, callId, nativeCallId = null }) {
  return store.run(
    'INSERT INTO message_origins(message_id,turn_id,event_seq,call_id,native_call_id) VALUES(?,?,?,?,?)',
    messageId,
    turnId,
    eventSeq,
    callId,
    nativeCallId,
  );
}

/** 指令回执状态:accepted 表示宿主已接收输入,不表示工作成功。 */
/** @param {StoreLike} store @param {string} messageId */
export function deliveryStateForMessage(store, messageId) {
  return store.get('SELECT o.accepted,o.error FROM attached a JOIN outbox o ON o.id=a.outbox_id WHERE a.message_id=?', messageId) ?? null;
}

/** 私聊互动答复的持久投递任务:答复正文先落 panel_messages,outbox 只持任务。 */
/** @param {StoreLike} store @param {string} id @param {string} conversationId @param {any} payload */
export function enqueueDelivery(store, id, conversationId, payload) {
  return store.run('INSERT INTO outbox(id,conversation_id,payload) VALUES(?,?,?)', id, conversationId, JSON.stringify(payload));
}

/** 回合产出的最后一条用户可见回复(panel 协作回合收尾用)。 */
/** @param {StoreLike} store @param {string} turnId */
export function finalReplyForTurn(store, turnId) {
  return store.get(
    "SELECT m.* FROM messages m JOIN message_origins o ON o.message_id=m.id WHERE o.turn_id=? AND m.recipient='user' AND m.reply_to IS NOT NULL ORDER BY m.seq DESC LIMIT 1",
    turnId,
  ) ?? null;
}

/** 团队指令回合的输入消息:只取触发过 team-directive 的 user 消息。 */
/** @param {StoreLike} store @param {string} turnId */
export function directiveInputMessages(store, turnId) {
  return store.all(
    `SELECT m.* FROM turn_inputs i JOIN messages m ON m.id=i.message_id
     JOIN operation_records d ON d.scope='team-directive' AND d.ref=m.id WHERE i.turn_id=? AND m.sender='user'`,
    turnId,
  );
}

/** 同一指令回合是否已发布过等价回复(同一收件人 + reply_to,或同回合同文本)。 */
/** @param {StoreLike} store @param {{ groupId: string, sender: string, replyTo: string, turnId: string, text: string }} input */
export function publishedDirectiveReply(store, { groupId, sender, replyTo, turnId, text }) {
  return store.get(
    `SELECT m.id FROM messages m LEFT JOIN message_origins o ON o.message_id=m.id
     WHERE m.group_id=? AND m.sender=? AND (m.reply_to=? OR (o.turn_id=? AND m.text=?)) LIMIT 1`,
    groupId, sender, replyTo, turnId, text,
  ) ?? null;
}

/** 指令编号的幂等回读:operation_records(scope='team-directive') -> 触发消息。 */
/** @param {StoreLike} store @param {{ groupId: string, operationId: string }} input */
export function directiveMessageByOperation(store, { groupId, operationId }) {
  return store.get(
    `SELECT m.* FROM operation_records d JOIN messages m ON m.id=d.ref
     WHERE d.scope='team-directive' AND d.scope_id=? AND d.client_key=?`,
    groupId, operationId,
  ) ?? null;
}

/** 团队最近 50 条指令编号 -> 触发消息。 */
/** @param {StoreLike} store @param {string} groupId */
export function directiveOperations(store, groupId) {
  return store.all(
    `SELECT d.client_key AS operation_id,m.id FROM operation_records d JOIN messages m ON m.id=d.ref
     WHERE d.scope='team-directive' AND d.scope_id=? ORDER BY m.seq DESC LIMIT 50`,
    groupId,
  );
}

/** 团队直发消息携带的必需能力声明:只影响投递匹配,不改消息本体其它列。 */
/** @param {StoreLike} store @param {string} messageId @param {string[]} capabilities */
export function setRequiredCapabilities(store, messageId, capabilities) {
  return store.run('UPDATE messages SET required_capabilities=? WHERE id=?', JSON.stringify(capabilities), messageId);
}

/** 外部主控接管送达后清掉等待位,避免同一消息被重复认领。 */
/** @param {StoreLike} store @param {string} messageId */
export function clearAwaiting(store, messageId) {
  return store.run('UPDATE messages SET awaiting=0 WHERE id=?', messageId);
}

/** 团队共享消息流:按 seq 升序返回该团队全部消息(note/system/send 同列),用于内容保留与不泄漏断言。 */
/** @param {StoreLike} store @param {string} groupId */
export function byGroup(store, groupId) {
  return store.all('SELECT * FROM messages WHERE group_id=? ORDER BY seq', groupId);
}

/** 投递台账全量:含已接受/失败的 outbox 行,按写入顺序;只含等待中队列的是 pending/pendingDeliveries。 */
/** @param {StoreLike} store */
export function deliveries(store) {
  return store.all('SELECT * FROM outbox ORDER BY rowid');
}
