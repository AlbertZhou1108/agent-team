import { randomUUID } from 'node:crypto';

// 互动卡:成员与 Panel 发起的问答、控制动作的决策、答复投递与请求卡创建。
// 本模块不反向依赖 Bus;跨职责调用一律经由传入的 bus 引用。

const actionInteractionKinds = new Set(['takeover', 'handback', 'group_create', 'group_add', 'group_delete', 'member_model']);

/** 动作请求的「同一决策」判据:只有同主体的新请求才替换旧 pending 卡,不同主体是独立决策、互不挤占。
 *  member_model/group_add/group_create 的主体记录在 args 里;takeover/handback/group_delete 每群只有一个决策槽。
 *  @param {string} kind @param {Record<string, any> | null | undefined} args */
export function actionSubjectKey(kind, args = {}) {
  if (kind === 'member_model') return args?.member ?? '';
  if (kind === 'group_add' || kind === 'group_create') return args?.name ?? '';
  return '';
}

/** @param {unknown} text */
function questionPreview(text) {
  const points = Array.from(typeof text === 'string' ? text : '');
  return points.length > 120 ? `${points.slice(0, 120).join('')}…` : points.join('');
}

/** @param {Record<string, any> | null | undefined} row
 * @returns {Record<string, any> | null | undefined} */
export function interactionView(row) {
  if (!row) return row;
  return {
    ...row,
    // 卡片锚点消息:成员/协作互动为群消息,Panel 私聊互动为 panel_messages 行。
    message_id: row.message_id ?? row.panel_message_id ?? null,
    payload: JSON.parse(row.payload),
    ...(row.answer ? { answer: JSON.parse(row.answer) } : {}),
  };
}

/** @param {import("./types.mjs").BusRef} bus */
export class Interactions {
  constructor(/** @type {import("./types.mjs").BusRef} */ bus) {
    this.bus = bus;
  }
  /** @param {string} id @param {Record<string, any> | null | undefined} answer */
  decideInteraction(id, answer) {
    const row = this.bus.store.interaction(id);
    if (!row) throw new Error('互动不存在');
    if (row.state !== 'pending') throw new Error('互动已经结束');
    const payload = JSON.parse(row.payload);
    if (actionInteractionKinds.has(row.kind)) return this.bus.decideActionInteraction(row, payload, answer);
    let text;
    if (row.kind === 'choice') {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.selected !== 'string' || !payload.options?.includes(answer.selected)) {
        throw new Error('答复必须是 options 中的一个选项');
      }
      text = `「${questionPreview(payload.text)}」用户选择:${answer.selected}`;
    } else if (row.kind === 'input') {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.value !== 'string' || !answer.value.trim() || answer.value.length > 48000) {
        throw new Error('答复必须包含 1-48000 字符的文本');
      }
      text = `「${questionPreview(payload.text)}」用户填写:\n${answer.value}`;
    } else throw new Error(`未知互动类型: ${row.kind}`);
    if (row.panel_agent_id) {
      if (row.message_id) {
        // 协作上下文发起:答复进群记录,经 pump 唤醒 Panel 主控 coordination 会话。
        const message = this.bus.store.transaction(() => {
          const value = this.bus.store.append(row.group_id, 'user', row.panel_agent_id, 'send', text, row.message_id);
          this.bus.store.setInteractionState(id, 'answered', answer, value.id);
          return value;
        });
        this.bus.emit('message', message);
        queueMicrotask(() => this.bus.pump());
      } else {
        // 私人上下文发起:答复持久入队,经 outbox 投递唤醒 Panel 私人会话。
        this.bus.store.setInteractionState(id, 'answered', answer);
        this.bus.enqueuePanelPrivateAnswer(row.panel_agent_id, text);
      }
      return interactionView(this.bus.store.interaction(id));
    }
    const message = this.bus.store.transaction(() => {
      const value = this.bus.store.append(row.group_id, 'user', row.member_id, 'send', text, row.message_id);
      this.bus.store.setInteractionState(id, 'answered', answer, value.id);
      return value;
    });
    this.bus.emit('message', message);
    queueMicrotask(() => this.bus.pump());
    return interactionView(this.bus.store.interaction(id));
  }
  /** @param {Record<string, any>} row @param {Record<string, any>} payload @param {Record<string, any> | null | undefined} answer */
  decideActionInteraction(row, payload, answer) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.approved !== 'boolean') {
      throw new Error('答复必须包含 approved 布尔值');
    }
    const executors = /** @type {Record<string, () => unknown>} */ ({
      takeover: () => this.bus.takeoverTeam(payload.groupId, payload.baseRevision),
      handback: () => this.bus.handbackTeam(payload.groupId, payload.baseRevision),
      group_create: () => this.bus.createGroup(payload.args),
      group_add: () => this.bus.addMember(row.group_id, payload.args),
      member_model: () => this.bus.applyMemberModel(row.group_id, payload.args.member, payload.args.model ? {
        model_provider: payload.args.model_provider ?? null,
        model: payload.args.model,
        reasoning_effort: payload.args.reasoning_effort ?? null,
      } : null),
    });
    const deliverOutcome = /** @param {string} text */ text => {
      if (row.panel_agent_id) return this.bus.enqueuePanelPrivateAnswer(row.panel_agent_id, text);
      const message = this.bus.store.append(row.group_id, 'user', row.member_id, 'send', text, row.message_id);
      this.bus.emit('message', message);
      queueMicrotask(() => this.bus.pump());
      return message;
    };
    // 先落账再执行,避免执行中的控制者变更收尾把本行误判为待取消。
    this.bus.store.setInteractionState(row.id, 'answered', answer);
    const decidedView = interactionView(this.bus.store.interaction(row.id));
    if (row.kind === 'group_delete' && answer.approved) {
      // 删除会级联清除卡片和发起会话；只等待结果，不投递成功消息。
      return this.bus.deleteGroup(row.group_id).then(() => decidedView, error => {
        this.bus.store.setInteractionState(row.id, 'failed', null, null, error.message);
        this.bus.deliverOutcomeSafe(row, deliverOutcome, `${payload.text}:用户已同意,但执行失败:${error.message}`);
        throw error;
      });
    }
    let outcome;
    if (!answer.approved) {
      outcome = `${payload.text}:用户已拒绝。`;
    } else {
      try {
        executors[row.kind]();
      } catch (error) {
        this.bus.store.setInteractionState(row.id, 'failed', null, null, /** @type {Error} */ (error).message);
        this.bus.deliverOutcomeSafe(row, deliverOutcome, `${payload.text}:用户已同意,但执行失败:${/** @type {Error} */ (error).message}`);
        throw error;
      }
      outcome = `${payload.text}:用户已同意,已生效。`;
    }
    this.bus.deliverOutcomeSafe(row, deliverOutcome, outcome);
    return row.kind === 'group_delete' ? decidedView : interactionView(this.bus.store.interaction(row.id));
  }
  /** @param {Record<string, any>} row @param {(text: string) => unknown} deliver @param {string} text */
  deliverOutcomeSafe(row, deliver, text) {
    try { deliver(text); } catch (error) {
      // 群删除等场景下发起会话可能已不存在;结果以卡片状态为准。
      if (!this.bus.closing) console.warn(`互动结果投递失败: ${/** @type {Error} */ (error).message}`);
    }
  }
  /** @param {Record<string, any>} member @param {string} text */
  memberInteractionAnchor(member, text) {
    const message = this.bus.store.append(member.group_id, member.id, 'user', 'send', text);
    this.bus.emit('message', message);
    return message;
  }
  /** @param {Record<string, any>} member @param {Record<string, any>} endpoint @param {Record<string, any> | null} origin @param {string} kind @param {string} text @param {object} args */
  requestGroupAction(member, endpoint, origin, kind, text, args) {
    return this.requestActionCard({
      requesterKind: 'member',
      requesterId: member.id,
      groupId: member.group_id,
      endpoint,
      origin,
      kind,
      text,
      args,
      anchor: anchorText => {
        const message = this.memberInteractionAnchor(member, anchorText);
        return { groupId: member.group_id, messageId: message.id, panelMessageId: null };
      },
    });
  }
  /** 动作卡统一入口:成员与 Panel 共用同一套「同主体去重 + 锚点 + 建卡」;
   *  同主体同文案复用 pending 卡,同主体不同文案以「请求内容已变化」取消旧卡。
   *  @param {{ requesterKind: 'member' | 'panel_agent', requesterId: string, groupId: string, endpoint: Record<string, any>, origin: Record<string, any> | null, kind: string, text: string, args: object, anchor: (anchorText: string) => { groupId?: string | null, messageId: string | null, panelMessageId: string | null }}} spec */
  requestActionCard({ requesterKind, requesterId, groupId, endpoint, origin, kind, text, args, anchor }) {
    const subject = actionSubjectKey(kind, args);
    const requesterColumn = requesterKind === 'member' ? 'member_id' : 'panel_agent_id';
    const existing = this.bus.store.all(
      `SELECT * FROM interactions WHERE ${requesterColumn}=? AND group_id=? AND kind=? AND state='pending' ORDER BY created DESC`,
      requesterId,
      groupId,
      kind,
    ).map(row => ({ row, payload: JSON.parse(row.payload) }))
      .find(item => actionSubjectKey(kind, item.payload.args) === subject);
    if (existing) {
      if (existing.payload.text === text) return interactionView(existing.row);
      this.bus.store.setInteractionState(existing.row.id, 'cancelled', null, null, '请求内容已变化');
    }
    const anchorRow = anchor(text);
    const row = this.bus.store.createInteraction({
      id: randomUUID(),
      groupId: anchorRow.groupId ?? groupId,
      ...(requesterKind === 'member' ? { memberId: requesterId } : { panelAgentId: requesterId }),
      endpointId: endpoint.id,
      context: endpoint.context,
      turnId: origin?.turnId ?? '',
      callId: origin?.callId ?? randomUUID(),
      messageId: anchorRow.messageId,
      panelMessageId: anchorRow.panelMessageId,
      kind,
      payload: { kind, text, args },
    });
    return interactionView(row);
  }
}
