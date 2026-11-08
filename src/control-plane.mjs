import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTROL_CAPABILITIES,
  CONTROL_PROTOCOL_VERSION,
  assertControlPolicy,
  assertControlWorkspace,
  assertControllerCapabilities,
  effectiveControlCapabilities,
  normalizeControlCapabilities,
  supportsControlCapability,
} from './control-capabilities.mjs';
import * as externalAgg from './aggregates/external-control.mjs';
import * as teamsAgg from './aggregates/teams.mjs';
import * as messagesAgg from './aggregates/messages.mjs';
import { appendRoutedMessage, assertReplyTarget, readSharedMessages } from './tool-ops.mjs';
import { roleNameKey } from './collaboration.mjs';
import { validateToolValue } from './tool-schema.mjs';
import { deliverExternalWake } from './external-delivery.mjs';
import { nodeRunner } from './runtime.mjs';

const CONTROL_GUIDE = [
  'Agent Team 是宿主无关的协作控制面。',
  '所有团队操作都必须显式传 teamId；不要根据隐式当前团队猜测。',
  'send 会唤醒接收方，note 不唤醒。消息进入外部主控时使用 control_inbox 领取。',
  '外部主控只能访问自己控制的团队；权限不得高于当前绑定声明的 workspaceRoots 和 policies。',
  '需要用户决定时，向当前主控发 decision_request；由主控询问用户后通过 decision_answer 回复。',
  '同步工具失败以 isError 返回；不应伪造用户确认、送达或工作完成。',
].join('\n');

const READ_ONLY_CONTROL_TOOLS = new Set([
  'control_protocol',
  'control_status',
  'control_teams',
  'team_snapshot',
  'team_members',
  'team_read',
  'control_decisions',
]);

function keyHash(key) {
  return createHash('sha256').update(key).digest('hex');
}

function normalizedMembers(value) {
  if (value === undefined || value === null || value === '') return [];
  const rows = Array.isArray(value)
    ? value
    : String(value).split(',').map(item => item.trim()).filter(Boolean);
  return rows.map(item => {
    if (typeof item === 'string') {
      const [name, host, ...extra] = item.split('=').map(part => part.trim());
      if (!name || !host || extra.length) throw new Error('成员格式应为 名称=宿主');
      return { name, host };
    }
    if (!item || typeof item !== 'object' || !item.name || !item.host) throw new Error('成员格式无效');
    return { name: String(item.name).trim(), host: String(item.host).trim() };
  });
}

function bindingCapabilities(row) {
  return effectiveControlCapabilities(
    JSON.parse(row.declared_capabilities),
    JSON.parse(row.probed_capabilities),
  );
}

function hasElicitation(capabilities) {
  return supportsControlCapability(capabilities, CONTROL_CAPABILITIES.userElicitation);
}

export function createExternalIdentity(store, {
  principalName = '本机用户',
  bindingName,
  host,
  command = null,
  session = null,
  declared,
  probed,
} = {}) {
  if (typeof principalName !== 'string' || !principalName.trim()) throw new Error('principalName 无效');
  if (typeof bindingName !== 'string' || !bindingName.trim()) throw new Error('bindingName 无效');
  if (typeof host !== 'string' || !host.trim()) throw new Error('host 无效');
  const declaredCapabilities = assertControllerCapabilities(declared ?? {});
  const probedCapabilities = normalizeControlCapabilities(probed ?? declaredCapabilities);
  const effective = effectiveControlCapabilities(declaredCapabilities, probedCapabilities);
  assertControllerCapabilities(effective);
  const now = new Date().toISOString();
  return store.transaction(() => {
    let owner = externalAgg.principalByName(store, principalName.trim());
    if (!owner) {
      owner = { id: randomUUID(), name: principalName.trim() };
      externalAgg.insertPrincipal(store, { id: owner.id, name: owner.name, created: now });
    }
    const key = randomBytes(32).toString('hex');
    const existing = externalAgg.bindingByName(store, owner.id, bindingName.trim());
    const id = existing?.id ?? randomUUID();
    if (existing) {
      externalAgg.rotateBinding(store, id, {
        host: host.trim(),
        command: command?.trim() || host.trim(),
        keyHash: keyHash(key),
        session: session ?? existing.session,
        declaredCapabilities,
        probedCapabilities: effective,
        updated: now,
      });
    } else {
      externalAgg.insertBinding(store, {
        id,
        principalId: owner.id,
        name: bindingName.trim(),
        host: host.trim(),
        command: command?.trim() || host.trim(),
        keyHash: keyHash(key),
        session,
        declaredCapabilities,
        probedCapabilities: effective,
        created: now,
      });
    }
    return {
      principal: owner,
      binding: externalAgg.binding(store, id),
      key,
      capabilities: effective,
    };
  });
}

export class ControlPlane {
  constructor(bus, { wake = deliverExternalWake } = {}) {
    this.bus = bus;
    this.wake = wake;
  }

  authenticate(bindingId, key, protocolVersion = CONTROL_PROTOCOL_VERSION, hostSession = null, clearHostSession = false) {
    if (typeof bindingId !== 'string' || typeof key !== 'string' || !bindingId || !key) {
      throw new Error('缺少外部主控连接凭据');
    }
    const row = externalAgg.binding(this.bus.store, bindingId);
    if (!row || row.status !== 'active' || row.key_hash !== keyHash(key)) throw new Error('外部主控连接凭据无效');
    const capabilities = bindingCapabilities(row);
    assertControllerCapabilities(capabilities);
    externalAgg.touchBinding(this.bus.store, row.id);
    if (this.bus.controlSocketPath) {
      const runner = nodeRunner();
      const wakeConfig = {
        command: runner.command,
        args: [
          '--disable-warning=ExperimentalWarning',
          fileURLToPath(new URL('./cli.mjs', import.meta.url)),
          'mcp',
          '--socket', this.bus.controlSocketPath,
          '--client', row.id,
        ],
        env: {
          ...runner.env,
          AGENT_TEAM_CLIENT_KEY: key,
          AGENT_TEAM_CONTROL_PROTOCOL: String(CONTROL_PROTOCOL_VERSION),
        },
      };
      const serialized = JSON.stringify(wakeConfig);
      if (serialized !== row.wake_config) {
        externalAgg.setBindingWakeConfig(this.bus.store, row.id, wakeConfig);
        row.wake_config = serialized;
      }
    }
    const sessionChanged = clearHostSession
      ? externalAgg.clearBindingSession(this.bus.store, row.id)
      : externalAgg.setBindingSession(this.bus.store, row.id, hostSession);
    if (sessionChanged) {
      row.session = clearHostSession ? null : String(hostSession).trim();
      for (const team of externalAgg.controlledTeams(this.bus.store, row.principal_id)) {
        this.scheduleWake(row.principal_id, team.id);
      }
    }
    return {
      binding: row,
      capabilities,
      protocol: protocolState(protocolVersion ?? CONTROL_PROTOCOL_VERSION),
    };
  }

  tools(bindingId, key, protocolVersion = CONTROL_PROTOCOL_VERSION, hostSession = null, clearHostSession = false) {
    const { capabilities, protocol } = this.authenticate(bindingId, key, protocolVersion, hostSession, clearHostSession);
    return toolsForControlCapabilities(capabilities)
      .filter(tool => protocol.compatible || READ_ONLY_CONTROL_TOOLS.has(tool.name));
  }

  bindSession(bindingId, key, session, protocolVersion = CONTROL_PROTOCOL_VERSION) {
    if (typeof session !== 'string' || !session.trim()) throw new Error('需要宿主 session');
    const { binding, protocol } = this.authenticate(bindingId, key, protocolVersion, session);
    return {
      bindingId: binding.id,
      session: binding.session,
      protocol,
    };
  }

  async tool(bindingId, key, name, args, protocolVersion = CONTROL_PROTOCOL_VERSION, hostSession = null, clearHostSession = false) {
    const { binding, capabilities, protocol } = this.authenticate(bindingId, key, protocolVersion, hostSession, clearHostSession);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
    if (!hasElicitation(capabilities) && ['control_decisions', 'team_decision_answer'].includes(name)) {
      throw new Error(`宿主未声明能力: ${CONTROL_CAPABILITIES.userElicitation}`);
    }
    const spec = toolsForControlCapabilities(capabilities).find(tool => tool.name === name);
    if (!spec) throw new Error('工具不存在');
    if (!protocol.compatible && !READ_ONLY_CONTROL_TOOLS.has(name)) {
      throw new Error(`MCP 协议不兼容：客户端 ${protocol.clientVersion}，服务 ${protocol.serverVersion}。请更新 Agent Team Skill 并新建宿主会话或重新连接；当前仅允许只读操作`);
    }
    for (const keyName of Object.keys(args)) {
      if (!Object.hasOwn(spec.inputSchema.properties, keyName)) throw new Error(`不允许的参数: ${keyName}`);
    }
    for (const keyName of spec.inputSchema.required) {
      if (!Object.hasOwn(args, keyName)) throw new Error(`缺少参数: ${keyName}`);
    }
    for (const [keyName, value] of Object.entries(args)) validateToolValue(spec.inputSchema.properties[keyName], value, keyName);
    if (name === 'control_protocol') return {
      version: CONTROL_PROTOCOL_VERSION,
      protocol,
      capabilities,
      guide: CONTROL_GUIDE,
    };
    if (name === 'control_status') return {
      binding: {
        id: binding.id,
        name: binding.name,
        host: binding.host,
        status: binding.status,
      },
      capabilities,
      delivery: externalAgg.deliveryStatus(this.bus.store, binding.principal_id),
      decisions: externalAgg.pendingDecisions(this.bus.store, binding.principal_id).length,
      protocol,
      controlledTeams: externalAgg.controlledTeams(this.bus.store, binding.principal_id).length,
    };
    if (name === 'control_teams') return {
      teams: externalAgg.controlledTeams(this.bus.store, binding.principal_id).map(team => ({
        ...team,
        active: team.controller_binding_id === binding.id,
      })),
    };
    if (name === 'control_inbox') {
      const limit = args.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 必须是 1-100');
      const deliveries = externalAgg.claimDeliveries(this.bus.store, {
        principalId: binding.principal_id,
        bindingId: binding.id,
        limit,
        now: new Date().toISOString(),
      });
      return { deliveries, nextAfter: null };
    }
    if (name === 'team_create') return this.createTeam(binding, capabilities, args);

    if (name === 'team_activate') {
      if (!externalAgg.controlsTeam(this.bus.store, binding.principal_id, args.teamId)) {
        throw new Error('外部主控无权访问该团队');
      }
      const assignment = externalAgg.activateTeam(this.bus.store, {
        groupId: args.teamId,
        principalId: binding.principal_id,
        bindingId: binding.id,
        now: new Date().toISOString(),
      });
      this.scheduleWake(binding.principal_id, args.teamId);
      return {
        teamId: args.teamId,
        activeBindingId: binding.id,
        revision: assignment.revision,
      };
    }
    const writeTools = new Set([
      'team_send',
      'team_note',
      'team_tasks_set',
      'team_stop_member',
      'team_decision_answer',
      'team_archive',
    ]);
    const group = this.assertControlledTeam(
      binding.principal_id,
      args.teamId,
      binding.id,
      { write: writeTools.has(name) },
    );
    if (name === 'control_decisions') {
      return {
        decisions: externalAgg.pendingDecisions(this.bus.store, binding.principal_id, {
          groupId: group.id,
          limit: args.limit ?? 50,
        }),
      };
    }
    if (name === 'team_snapshot') return this.snapshot(group, binding.principal_id);
    if (name === 'team_members') return { teamId: group.id, controllerId: binding.principal_id, members: this.bus.members(group.id) };
    if (name === 'team_read') {
      return readSharedMessages(this.bus, {
        groupId: group.id,
        args,
        schema: 2,
        resolveSenderId: sender => {
          if (!sender) return null;
          if (sender === 'user' || sender === 'system') return sender;
          if (sender === binding.principal_id) return binding.principal_id;
          return this.bus.resolveMember(group.id, sender).id;
        },
      });
    }
    if (name === 'team_send' || name === 'team_note') {
      this.bus.collaboration.requireCommunication(group.id);
      const to = args.to;
      const text = args.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 48000) throw new Error('消息正文无效');
      const target = this.bus.resolveRecipient(group.id, to);
      if (target.id === binding.principal_id) throw new Error('不能向主控自己发送团队消息');
      const expectsReply = name === 'team_send' && args.expectsReply === true;
      if (name === 'team_send' && args.replyTo !== undefined) {
        assertReplyTarget(this.bus.store, group.id, args.replyTo, binding.principal_id, target.id);
      }
      const message = appendRoutedMessage(this.bus.store, {
        groupId: group.id,
        senderId: binding.principal_id,
        targetId: target.id,
        kind: name === 'team_send' ? 'send' : 'note',
        text,
        replyTo: args.replyTo ?? null,
        expectsReply,
      });
      this.bus.emit('message', message);
      queueMicrotask(() => this.bus.pump());
      return { messageId: message.id };
    }
    if (name === 'team_tasks_set') {
      this.bus.collaboration.requireCommunication(group.id);
      return this.bus.setAgentTasks({
        groupId: group.id,
        ownerId: binding.principal_id,
        tasks: args.tasks,
      });
    }
    if (name === 'team_stop_member') {
      const target = this.bus.resolveMember(group.id, args.member);
      await this.bus.stopWhere(endpoint => endpoint.member_id === target.id);
      return { stopped: target.id };
    }
    if (name === 'team_decision_answer') {
      this.bus.collaboration.requireCommunication(group.id);
      if (typeof args.requestId !== 'string' || !args.requestId) throw new Error('需要 requestId');
      const existing = externalAgg.decision(this.bus.store, args.requestId);
      if (!existing || existing.controller_principal_id !== binding.principal_id) throw new Error('决策请求不属于当前外部主控');
      if (existing.group_id !== group.id) throw new Error('决策请求不属于当前团队');
      const answeredAt = new Date().toISOString();
      const { decision, message } = this.bus.store.transaction(() => {
        const decided = externalAgg.answerDecision(this.bus.store, {
          id: args.requestId,
          principalId: binding.principal_id,
          bindingId: binding.id,
          answer: args.answer,
          answered: answeredAt,
        });
        return {
          decision: decided,
          message: messagesAgg.append(
            this.bus.store,
            group.id,
            'user',
            decided.requester_member_id,
            'send',
            decided.answer,
            decided.request_message_id,
          ),
        };
      });
      this.bus.emit('message', message);
      queueMicrotask(() => this.bus.pump());
      return {
        requestId: decision.id,
        state: decision.state,
        messageId: message.id,
        requesterMemberId: decision.requester_member_id,
      };
    }
    if (name === 'team_archive') {
      const result = await this.bus.archiveGroup(group.id);
      return { team: result };
    }
    throw new Error('工具不存在');
  }

  enqueueIncomingMessage(principalId, message) {
    if (!externalAgg.controlsTeam(this.bus.store, principalId, message.group_id)) return false;
    const now = new Date().toISOString();
    const notes = this.bus.store.all(
      `SELECT m.* FROM messages m
       WHERE m.group_id=? AND m.sender=? AND m.recipient=? AND m.kind='note'
         AND NOT EXISTS(SELECT 1 FROM external_deliveries d WHERE d.message_id=m.id)
       ORDER BY m.seq`,
      message.group_id,
      message.sender,
      principalId,
    );
    this.bus.store.transaction(() => {
      for (const note of notes) {
        externalAgg.enqueueDelivery(this.bus.store, {
          id: randomUUID(),
          principalId,
          groupId: message.group_id,
          messageId: note.id,
          payload: {
            kind: 'note',
            teamId: message.group_id,
            message: note,
          },
          created: now,
        });
      }
      externalAgg.enqueueDelivery(this.bus.store, {
        id: randomUUID(),
        principalId,
        groupId: message.group_id,
        messageId: message.id,
        payload: {
          kind: 'send',
          teamId: message.group_id,
          teamName: this.bus.store.group(message.group_id).name,
          message,
        },
        created: now,
      });
      this.bus.store.run('UPDATE messages SET awaiting=0 WHERE id=?', message.id);
    });
    this.scheduleWake(principalId, message.group_id);
    return true;
  }

  scheduleWake(principalId, groupId) {
    setImmediate(() => {
      void this.wakePending(principalId, groupId).catch(error => {
        if (!this.bus.closing) console.error('[control] 外部唤醒调度失败:', error.message);
      });
    });
  }

  async wakePending(principalId, groupId) {
    if (this.bus.closing) return { state: 'closed' };
    const binding = externalAgg.activeBindingForTeam(this.bus.store, principalId, groupId);
    const rows = externalAgg.pendingWakes(this.bus.store, principalId, groupId);
    if (!rows.length) return { state: 'empty' };
    if (!binding) {
      externalAgg.markWake(this.bus.store, rows.map(row => row.id), {
        state: 'unsupported',
        error: 'active controller binding 不存在或已禁用',
      });
      return { state: 'unsupported', count: rows.length };
    }
    externalAgg.markWake(this.bus.store, rows.map(row => row.id), {
      bindingId: binding.id,
      state: 'sending',
    });
    const teamName = this.bus.store.group(groupId).name;
    try {
      const result = await this.wake(binding, { teamName, count: rows.length });
      if (!result.supported) {
        externalAgg.markWake(this.bus.store, rows.map(row => row.id), {
          bindingId: binding.id,
          state: 'unsupported',
          error: result.reason ?? '宿主不支持主动唤醒',
        });
        return { state: 'unsupported', count: rows.length, reason: result.reason };
      }
      externalAgg.markWake(this.bus.store, rows.map(row => row.id), {
        bindingId: binding.id,
        state: 'sent',
      });
      return { state: 'sent', count: rows.length };
    } catch (error) {
      externalAgg.markWake(this.bus.store, rows.map(row => row.id), {
        bindingId: binding.id,
        state: 'error',
        error: error.message,
      });
      return { state: 'error', count: rows.length, reason: error.message };
    }
  }

  requestDecision({ groupId, memberId, payload }) {
    const controller = this.bus.teamController(groupId);
    if (controller.kind !== 'external_agent') return null;
    const binding = externalAgg.activeBindingForTeam(this.bus.store, controller.id, groupId);
    if (!binding || !hasElicitation(bindingCapabilities(binding))) {
      throw new Error(`当前外部主控未声明能力: ${CONTROL_CAPABILITIES.userElicitation}`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const message = this.bus.store.transaction(() => {
      const row = messagesAgg.append(
        this.bus.store,
        groupId,
        memberId,
        controller.id,
        'send',
        payload.text,
        null,
        true,
      );
      externalAgg.insertDecision(this.bus.store, {
        id,
        groupId,
        requesterMemberId: memberId,
        controllerPrincipalId: controller.id,
        requestMessageId: row.id,
        payload,
        created: now,
      });
      return row;
    });
    this.bus.emit('message', message);
    queueMicrotask(() => this.bus.pump());
    return { decisionId: id, state: 'pending' };
  }

  assertControlledTeam(principalId, teamId, bindingId, { write = false } = {}) {
    if (typeof teamId !== 'string' || !teamId) throw new Error('需要 teamId');
    const group = this.bus.store.group(teamId);
    if (!externalAgg.controlsTeam(this.bus.store, principalId, teamId)) throw new Error('外部主控无权访问该团队');
    if (write) {
      const assignment = teamsAgg.controllerAssignment(this.bus.store, teamId);
      if (assignment?.controller_kind !== 'external_agent' || assignment.controller_id !== principalId) {
        throw new Error('团队主控身份已变化');
      }
      if (assignment.controller_binding_id !== bindingId) {
        throw new Error('该连接不是团队当前 active controller session；请先调用 team_activate');
      }
    }
    return group;
  }

  createTeam(binding, capabilities, args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name || name.length > 200) throw new Error('团队名称无效');
    if (typeof args.workspace !== 'string' || !args.workspace) throw new Error('工作目录无效');
    let workspace;
    try {
      workspace = realpathSync(resolve(args.workspace));
      if (!statSync(workspace).isDirectory()) throw new Error('工作目录无效');
    } catch {
      throw new Error('工作目录无效');
    }
    const workspaceRoots = capabilities.workspaceRoots.map(root => {
      try {
        const canonical = realpathSync(root);
        return statSync(canonical).isDirectory() ? canonical : root;
      } catch {
        return root;
      }
    });
    assertControlWorkspace({ ...capabilities, workspaceRoots }, workspace);
    const policy = assertControlPolicy(capabilities, args.policy ?? 'read-only');
    const people = normalizedMembers(args.members);
    const operationId = typeof args.operationId === 'string' && /^[\w-]{1,128}$/.test(args.operationId)
      ? args.operationId
      : null;
    if (args.operationId !== undefined && !operationId) throw new Error('operationId 无效');
    const payload = JSON.stringify({
      principalId: binding.principal_id,
      name,
      workspace,
      policy,
      allowShell: args.allowShell === true,
      people,
      charter: args.charter ?? null,
    });
    if (operationId) {
      const previous = this.bus.store.get(
        "SELECT * FROM operation_records WHERE scope='external-team-create' AND scope_id=? AND client_key=?",
        binding.principal_id,
        operationId,
      );
      if (previous) {
        if (previous.payload !== payload) throw new Error('operationId 已用于不同建群内容');
        return { team: this.bus.store.group(previous.ref), controllerId: binding.principal_id, replayed: true };
      }
    }
    const names = new Set();
    for (const person of people) {
      this.bus.requireHost(person.host);
      if (!person.name || person.name.length > 100) throw new Error('成员名称无效');
      const key = roleNameKey(person.name);
      if (names.has(key)) throw new Error('成员名称重复');
      names.add(key);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.bus.store.transaction(() => {
      teamsAgg.insertGroup(this.bus.store, {
        id,
        name,
        workspace,
        created: now,
        charter: typeof args.charter === 'string' && args.charter.trim() ? args.charter.trim() : null,
        policy,
        allowShell: args.allowShell === true ? 1 : 0,
      });
      teamsAgg.insertExternalController(this.bus.store, {
        groupId: id,
        principalId: binding.principal_id,
        bindingId: binding.id,
        now,
      });
      for (const person of people) {
        const memberId = randomUUID();
        teamsAgg.insertMember(this.bus.store, {
          id: memberId,
          groupId: id,
          name: person.name,
          host: person.host,
          role: 'member',
          selection: this.bus.defaultModelSelection(person.host),
        });
        this.bus.collaboration.reserveMemberName(id, memberId, person.name);
      }
      if (operationId) {
        this.bus.store.run(
          "INSERT INTO operation_records(scope,scope_id,client_key,payload,ref,created) VALUES('external-team-create',?,?,?,?,?)",
          binding.principal_id,
          operationId,
          payload,
          id,
          now,
        );
      }
    });
    for (const member of this.bus.members(id)) if (!member.profile) this.bus.introduce(member);
    return { team: this.bus.store.group(id), controllerId: binding.principal_id, replayed: false };
  }

  snapshot(group, principalId) {
    return {
      team: group,
      controller: { id: principalId, kind: 'external_agent' },
      members: this.bus.members(group.id),
      communication: this.bus.groupSummary(group.id),
      tasks: this.bus.agentTasksView(group.id),
    };
  }
}

export function toolsForControlCapabilities(capabilities) {
  const teamId = { type: 'string', minLength: 1, maxLength: 200 };
  const text = { type: 'string', minLength: 1, maxLength: 48000 };
  const definitions = [
    ['control_protocol', '读取当前 Agent Team 协议、连接能力和无头协作说明。', {}, []],
    ['control_status', '查看当前绑定、能力、团队数量和外部收件箱状态。', {}, []],
    ['control_teams', '列出当前外部主控控制的团队。', {}, []],
    ['team_activate', '把当前 client binding 设为团队 active controller session；同身份其他会话随即只读。', { teamId }, ['teamId']],
    ['control_inbox', '领取待投递给当前外部主控的团队消息；领取表示客户端接受输入，不表示宿主回合已经完成。', {
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, []],
    ['team_create', '以当前外部主控身份创建团队；工作目录必须位于绑定的 workspace roots 内。', {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      workspace: { type: 'string', minLength: 1, maxLength: 4096 },
      members: { type: 'string', maxLength: 16000 },
      charter: { type: 'string', maxLength: 48000 },
      policy: { type: 'string', enum: ['communication', 'read-only', 'workspace-write'] },
      allowShell: { type: 'boolean' },
      operationId: { type: 'string', minLength: 1, maxLength: 128 },
    }, ['name', 'workspace']],
    ['team_snapshot', '读取一个受控团队的基础快照、成员、沟通状态与任务。', { teamId }, ['teamId']],
    ['team_members', '读取受控团队成员。', { teamId }, ['teamId']],
    ['team_read', '分页读取受控团队共享消息。', {
      teamId,
      after: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      sender: text,
      messageId: text,
      hash: text,
      offset: { type: 'integer', minimum: 0 },
      bodyLimit: { type: 'integer', minimum: 1, maximum: 4096 },
    }, ['teamId']],
    ['team_send', '以当前主控身份向成员发送会唤醒的正式消息。', {
      teamId, to: text, text,
      expectsReply: { type: 'boolean' },
      replyTo: { type: 'string', minLength: 1, maxLength: 100 },
    }, ['teamId', 'to', 'text']],
    ['team_note', '向成员留下不唤醒的留言；留言只随成员下一轮正式输入交付，不进入主控收件箱。', { teamId, to: text, text }, ['teamId', 'to', 'text']],
    ['team_tasks_set', '整体更新当前主控在该团队的计划步骤。', {
      teamId,
      tasks: { type: 'array', minItems: 0, maxItems: 20 },
    }, ['teamId', 'tasks']],
    ['team_stop_member', '停止受控团队中某成员当前回合。', { teamId, member: text }, ['teamId', 'member']],
    ['control_decisions', '列出当前团队仍待用户决定、需要外部主控转述的请求。', {
      teamId,
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, ['teamId']],
    ['team_decision_answer', '把用户决定以 user-origin 消息送回原成员并唤醒。', {
      teamId,
      requestId: text,
      answer: { type: 'string', minLength: 1, maxLength: 16000 },
    }, ['teamId', 'requestId', 'answer']],
    ['team_archive', '归档受控团队；外部主控不能永久删除团队。', { teamId }, ['teamId']],
  ];
  const canElicit = capabilities == null || hasElicitation(capabilities);
  return definitions.filter(([name]) => (
    canElicit || !['control_decisions', 'team_decision_answer'].includes(name)
  )).map(([name, description, properties, required]) => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  }));
}

function protocolState(value) {
  const parsed = Number(value);
  const clientVersion = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  return {
    clientVersion,
    serverVersion: CONTROL_PROTOCOL_VERSION,
    compatible: clientVersion === CONTROL_PROTOCOL_VERSION,
    readOnly: clientVersion !== CONTROL_PROTOCOL_VERSION,
  };
}
