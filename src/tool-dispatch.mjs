// 工具分派:成员工具入口、规则/入群自述、工具执行与结果测量。
// 从 Bus 抽出后,执行逻辑不再挤在总线门面里;Bus 只保留同名转发方法。
import { randomUUID } from 'node:crypto';
import { validateTool } from './tools.mjs';
import { memberModelSummary } from './model-policy.mjs';
import { assertReplyTarget, appendRoutedMessage, assertAskCard, askCardPayload, readSharedMessages } from './tool-ops.mjs';
import { memberRules, legacyMemberRules, profileIntro } from './prompts.mjs';
import { CONTEXT_SCHEMA_VERSION } from './information.mjs';
import * as teamsAgg from './aggregates/teams.mjs';

export class ToolDispatch {
  constructor(bus) {
    this.bus = bus;
  }

  rules(endpoint, schema = this.bus.information.memberSchemaForEndpoint(endpoint.id)) {
    const member = this.bus.store.member(endpoint.member_id);
    if (schema === CONTEXT_SCHEMA_VERSION) {
      const modelPolicy = member.role === 'lead' && ['coordination', 'private'].includes(endpoint.context) ? this.bus.modelPolicy() : null;
      return memberRules(member, { modelPolicy });
    }
    // Legacy sessions keep plain communication rules; their turn inputs stay
    // raw JSON so old host conversations remain readable.
    const membersJson = JSON.stringify(this.bus.members(member.group_id).map(({ id, name, profile }) => ({ id, name, profile })));
    return legacyMemberRules(member, membersJson);
  }
  introduce(member) {
    if (this.bus.closing) return;
    const endpoint = this.bus.store.conversation('member', member.id, 'profile');
    this.bus.runEndpoint(endpoint, profileIntro()).catch(error => {
      if (!this.bus.closing) this.bus.notify(member.group_id, this.bus.teamController(member.group_id).id, `成员 ${member.name} 入群说明失败：${error.message}`);
    });
  }
  async tool(endpointId, key, name, args, provenance = {}) {
    // 归属由会话行决定,不再依赖 id 前缀约定。
    if (this.bus.store.conversationById(endpointId)?.owner_kind === 'panel_agent') return this.bus.panelTool(endpointId, key, name, args, provenance);
    const endpoint = this.bus.store.authenticate(endpointId, key);
    const member = this.bus.store.member(endpoint.member_id);
    validateTool(member.role, name, args, endpoint.context);
    const { turnId, nativeCallId = null } = provenance;
    if (turnId && this.bus.running.get(endpointId)?.turnId !== turnId) throw new Error('工具不属于当前执行回合');
    const origin = turnId ? { turnId, callId: randomUUID(), nativeCallId } : null;
    if (origin) origin.eventSeq = this.bus.events.member(endpointId, { type: 'framework.tool_call', name, args, callId: origin.callId, nativeCallId }, turnId);
    try {
      const result = await this.executeTool(endpointId, key, name, args, origin);
      this.measureToolCall({ groupId: member.group_id, endpointId, turnId, name, args, result, schema: this.bus.information.toolSchema(turnId, endpointId) });
      if (origin) this.bus.events.member(endpointId, { type: 'framework.tool_result', callId: origin.callId, result }, turnId);
      return result;
    } catch (error) {
      if (origin) this.bus.events.member(endpointId, { type: 'framework.tool_result', callId: origin.callId, error: error.message }, turnId);
      throw error;
    }
  }
  measureToolCall({ groupId, endpointId, turnId, name, args, result, schema }) {
    if (!turnId) return;
    try {
      const detail = { view: result?.view ?? null, complete: result?.complete ?? null, hasMore: result?.hasMore ?? null };
      if (args?.messageId) {
        detail.expansion = true;
        detail.messageId = args.messageId;
        detail.offset = result?.offset ?? args.offset ?? 0;
        detail.bodyLimit = args.bodyLimit ?? null;
        detail.next = result?.next ?? null;
      }
      if (args?.itemId) detail.itemId = args.itemId;
      if (Array.isArray(result?.omissions)) detail.omissions = result.omissions.length;
      this.bus.information.measureToolResult({ groupId, endpointId, turnId, schemaVersion: schema, name, result, detail });
    } catch {
      // Measurement is observational and must never change a tool outcome.
    }
  }
  async executeTool(endpointId, key, name, args, origin) {
    const endpoint = this.bus.store.authenticate(endpointId, key);
    const member = this.bus.store.member(endpoint.member_id);
    validateTool(member.role, name, args, endpoint.context);
    const groupId = member.group_id;
    if (name === 'model_catalog') return this.bus.modelCatalog({ refresh: true });
    if (name === 'members') return this.bus.members(groupId).map(({ id, name: displayName, host, role, profile }) => ({ id, name: displayName, host, role, profile }));
    if (name === 'read') {
      const schema = this.bus.information.toolSchema(origin?.turnId, endpoint.id);
      return readSharedMessages(this.bus, {
        groupId,
        args,
        schema,
        resolveSenderId: sender => (sender ? this.bus.resolveMember(groupId, sender).id : null),
      });
    }
    if (name === 'profile_set') { teamsAgg.updateMemberProfile(this.bus.store, member.id, args.text); return { member: member.id, profile: args.text }; }
    if (name === 'send' || name === 'note') {
      this.bus.collaboration.requireCommunication(groupId);
      const target = this.bus.resolveRecipient(groupId, args.to);
      if (target.id === member.id) throw new Error('不能向自己发消息');
      const expectsReply = name === 'send' && args.expects_reply === true;
      if (name === 'send' && args.reply_to !== undefined) {
        assertReplyTarget(this.bus.store, groupId, args.reply_to, member.id, target.id);
      }
      const message = appendRoutedMessage(this.bus.store, {
        groupId,
        senderId: member.id,
        targetId: target.id,
        kind: name,
        text: args.text,
        replyTo: args.reply_to ?? null,
        expectsReply,
        origin,
      });
      this.bus.emit('message', message);
      if (origin?.turnId) {
        this.bus.completeToolMessageStream(
          origin.turnId,
          name,
          args,
          { messageId: message.id },
          origin.nativeCallId,
        );
      }
      queueMicrotask(() => this.bus.pump());
      return { messageId: message.id };
    }
    if (name === 'ask') {
      // 先校验入参形态,再判回合来源:参数错误与上下文错误各自给出明确原因。
      assertAskCard(args);
      if (!origin) throw new Error('互动卡只能在执行回合内发出');
      this.bus.collaboration.requireCommunication(groupId);
      if (member.role !== 'lead') this.bus.store.conversation('member', member.id, 'pair:user', { peer: 'user' });
      // 卡片是唯一展示面:锚点消息只为答复 reply_to 与群记录存在,面板不渲染它的正文。
      const payload = askCardPayload(args);
      const message = appendRoutedMessage(this.bus.store, {
        groupId,
        senderId: member.id,
        targetId: 'user',
        kind: 'send',
        text: payload.text,
        origin,
      });
      this.bus.emit('message', message);
      const interaction = this.bus.store.createInteraction({
        id: randomUUID(),
        groupId,
        memberId: member.id,
        endpointId: endpoint.id,
        context: endpoint.context,
        turnId: origin.turnId,
        callId: origin.callId,
        messageId: message.id,
        kind: payload.kind,
        payload,
      });
      return { interaction: interaction.id, state: interaction.state };
    }
    if (name === 'tasks_set') {
      return this.bus.setAgentTasks({ groupId, ownerId: member.id, tasks: args.tasks });
    }
    if (name === 'groups') return teamsAgg.groupsAll(this.bus.store);
    if (name === 'group_create') {
      const people = (args.members ?? '').split(',').filter(Boolean).map(item => {
        const [name, host, ...extra] = item.trim().split('=');
        if (!name || !host || extra.length) throw new Error('成员格式应为 名称=宿主');
        this.bus.requireHost(host);
        return { name, host };
      });
      return this.bus.requestGroupAction(member, endpoint, origin, 'group_create',
        `请求创建团队「${args.name}」（工作区 ${args.workspace}）`,
        { name: args.name, workspace: args.workspace, lead: { name: member.name, host: member.host }, members: people });
    }
    if (name === 'group_add') {
      this.bus.requireHost(args.host);
      if (args.name.trim().length > 100) throw new Error('成员名称无效');
      return this.bus.requestGroupAction(member, endpoint, origin, 'group_add',
        `请求向本群添加成员 ${args.name}（${args.host}）`,
        { name: args.name, host: args.host });
    }
    if (name === 'group_remove') return this.bus.removeMember(groupId, args.member);
    if (name === 'group_delete') {
      return this.bus.requestGroupAction(member, endpoint, origin, 'group_delete',
        `请求删除群 ${this.bus.store.group(groupId).name} 的配置与消息记录`,
        {});
    }
    if (name === 'member_model') {
      const target = this.bus.resolveMember(groupId, args.member);
      if (target.role !== 'member') throw new Error('member_model 只能调整普通成员');
      const selection = await this.bus.validateMemberModelSelection(target, args);
      return this.bus.requestGroupAction(member, endpoint, origin, 'member_model',
        `请求将成员 ${target.name} 的模型调整为 ${memberModelSummary(selection)}`,
        { member: args.member, ...(selection ?? {}) });
    }
    throw new Error('工具不存在');
  }
}
