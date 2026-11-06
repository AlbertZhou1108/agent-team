// 工具操作共享核心:成员工具(bus.executeTool)与 Panel 工具(panel.executePanelTool)
// 的重合逻辑收口在此,执行器只保留工具名分发与执行者差异(权限门禁、目标解析、锚点)。
import * as messagesAgg from './aggregates/messages.mjs';

/** 回复指向校验:只能回复发给自己、期待答复的 send,且答复对象必须是原请求发送者。 */
export function assertReplyTarget(store, groupId, replyTo, senderId, targetId) {
  const replyTarget = messagesAgg.replyTarget(store, replyTo, groupId);
  if (!replyTarget) throw new Error('回复的原消息不存在或不属于当前团队');
  if (replyTarget.kind !== 'send' || replyTarget.expects_reply !== 1) throw new Error('只能回复一条期待答复的消息');
  if (replyTarget.recipient !== senderId) throw new Error('不能回复不是发给自己的请求');
  if (replyTarget.sender !== targetId) throw new Error('回复对象必须是原请求的发送者');
}

/** 落一条带来源的正式消息:消息与 message_origins 同事务;无回合来源时不写 origins。 */
export function appendRoutedMessage(store, { groupId, senderId, targetId, kind, text, replyTo = null, expectsReply = false, origin = null }) {
  return store.transaction(() => {
    const value = messagesAgg.append(store, groupId, senderId, targetId, kind, text, replyTo, expectsReply);
    if (origin) {
      messagesAgg.insertOrigin(store, {
        messageId: value.id,
        turnId: origin.turnId ?? null,
        eventSeq: origin.eventSeq ?? null,
        callId: origin.callId,
        nativeCallId: origin.nativeCallId ?? null,
      });
    }
    return value;
  });
}

// 提问卡入参:单问(kind+text+options)与多步(steps)两种形态。工具 schema 无法表达
// "二选一",required 交给 assertAskCard 在 Bus 层判定(与 options 配对约束同一处)。
const askText = { type: 'string', minLength: 1, maxLength: 48000 };
const askOptions = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 2, maxItems: 8 };
const askKinds = ['choice', 'input'];
export const ASK_MAX_STEPS = 8;

export const askInputProperties = {
  kind: { type: 'string', enum: askKinds },
  text: askText,
  options: askOptions,
  steps: {
    type: 'array',
    minItems: 2,
    maxItems: ASK_MAX_STEPS,
    items: {
      type: 'object',
      properties: { kind: { type: 'string', enum: askKinds }, text: askText, options: askOptions },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
  },
};

/** 单问与多步二选一;每种形态各自补齐 kind/text/options 的配对规则。 */
export function assertAskCard(args) {
  if (args.steps !== undefined) {
    if (args.kind !== undefined || args.options !== undefined) throw new Error('steps 不能与 kind/options 同时使用');
    if (!Array.isArray(args.steps) || args.steps.length < 2) throw new Error('steps 至少需要 2 步');
    if (args.steps.length > ASK_MAX_STEPS) throw new Error(`steps 最多 ${ASK_MAX_STEPS} 步`);
    args.steps.forEach((step, index) => assertAskStep(step, index + 1));
    return;
  }
  if (!args.kind || !args.text) throw new Error('缺少 kind 与 text(多步提问改用 steps)');
  assertAskPairing(args.kind, args.options, '');
}

function assertAskStep(step, index) {
  const label = `第 ${index} 步`;
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${label}格式无效`);
  if (!askKinds.includes(step.kind)) throw new Error(`${label} kind 只能是 choice 或 input`);
  if (typeof step.text !== 'string' || !step.text.trim()) throw new Error(`${label}缺少问题文本`);
  assertAskPairing(step.kind, step.options, label);
}

function assertAskPairing(kind, options, label) {
  if (kind === 'choice' && !Array.isArray(options)) throw new Error(`${label}choice 必须提供 options`);
  if (kind === 'input' && options !== undefined) throw new Error(`${label}input 不接受 options`);
}

/** 卡片载荷:cardOnly 表示这条卡片是唯一展示面,锚点消息只作答复与群记录,不渲染正文。 */
export function askCardPayload(args) {
  if (Array.isArray(args.steps)) {
    const steps = args.steps.map(step => ({
      kind: step.kind,
      text: step.text,
      ...(step.options ? { options: step.options } : {}),
      answer: null,
    }));
    return { kind: 'flow', text: args.text ?? steps[0].text, steps, cardOnly: true };
  }
  return { kind: args.kind, text: args.text, ...(args.options ? { options: args.options } : {}), cardOnly: true };
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
