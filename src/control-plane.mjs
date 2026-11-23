import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONTROL_CAPABILITIES,
  CONTROL_PROTOCOL_VERSION,
  assertControlPolicy,
  assertControlWorkspace,
} from './control-capabilities.mjs';
import * as externalAgg from './aggregates/external-control.mjs';
import * as teamsAgg from './aggregates/teams.mjs';
import * as messagesAgg from './aggregates/messages.mjs';
import { appendRoutedMessage, assertReplyTarget, readSharedMessages } from './tools/ops.mjs';
import { roleNameKey } from './collaboration.mjs';
import { validateToolValue } from './tools/schema.mjs';
import { deliverExternalWake } from './external-delivery.mjs';
import { wakeDriverFor } from './host-runtime/wake-drivers.mjs';
import { surfaceFollowsConversation } from './hosts/definitions.mjs';
import * as identity from './control/identity.mjs';
import * as wake from './control/wake-scheduler.mjs';
import { READ_ONLY_CONTROL_TOOLS, toolsForControlCapabilities } from './control/tools.mjs';
import { normalizeMemberPolicyPatch } from './hosts/capability-routing.mjs';
import { normalizeWorkflowTemplateId } from './hosts/workflow-templates.mjs';
import { provisionMemberWorktrees } from './hosts/worktree.mjs';

const CONTROL_GUIDE = [
  'Agent Team 是宿主无关的协作控制面。',
  '所有团队操作都必须显式传 teamId；不要根据隐式当前团队猜测。',
  'send 会唤醒接收方，note 不唤醒。消息进入外部主控时使用 control_inbox 领取。',
  '外部主控只能访问自己控制的团队；权限不得高于当前绑定声明的 workspaceRoots 和 policies。',
  '支持主动唤醒的宿主必须先通过 control_wake_test 的真实唤醒才能派发工作；也可以显式接受 binding 级 Pull-only。',
  '成员模型由 team_create 或 team_member_model 按宿主实时目录选择，不静默回退。',
  'Group policy 是上限；成员有效策略与宿主能力取交集。派工前先看 team_members 的能力名片；team_send 可用 requiredCapabilities 与 minContextWindow 阻止不兼容派单，写库前与执行前各校验一次。',
  '需要用户决定时，向当前主控发 decision_request；由主控询问用户后通过 decision_answer 回复。',
  '同步工具失败以 isError 返回；不应伪造用户确认、送达或工作完成。',
].join('\n');

export class ControlPlane {
  constructor(bus, { wake = deliverExternalWake } = {}) {
    this.bus = bus;
    this.wake = wake;
    this.wakeSchedules = new Map();
    this.wakeInFlight = new Set();
  }

  /** 激活连接解析与鉴权委托：实现在 control/identity.mjs（首参 this）。 */
  resolveActivationBinding(activation, hostSession) {
    return identity.resolveActivationBinding(this, activation, hostSession);
  }

  latestBoundConversation(activation) {
    return identity.latestBoundConversation(this, activation);
  }

  resolveThreadBinding(activation, identityKey) {
    return identity.resolveThreadBinding(this, activation, identityKey);
  }

  authenticate(bindingId, key, protocolVersion = CONTROL_PROTOCOL_VERSION, hostSession = null, clearHostSession = false, hostCwd = null) {
    return identity.authenticate(this, bindingId, key, protocolVersion, hostSession, clearHostSession, hostCwd);
  }

  tools(bindingId, key, protocolVersion = CONTROL_PROTOCOL_VERSION, hostSession = null, clearHostSession = false, hostCwd = null) {
    const { capabilities, protocol } = this.authenticate(bindingId, key, protocolVersion, hostSession, clearHostSession, hostCwd);
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

  async tool(bindingId, key, name, args, protocolVersion = CONTROL_PROTOCOL_VERSION, hostSession = null, clearHostSession = false, hostCwd = null) {
    const { binding, capabilities, protocol } = this.authenticate(bindingId, key, protocolVersion, hostSession, clearHostSession, hostCwd);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
    if (!identity.hasElicitation(capabilities) && ['control_decisions', 'team_decision_answer'].includes(name)) {
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
    if (name === 'control_wake_test') {
      if (!binding.session) throw new Error('没有可恢复的宿主 session');
      if (!wakeDriverFor(binding.host)) throw new Error(`宿主 ${binding.host} 尚未实现主动唤醒`);
      if (!capabilities.capabilities.includes(CONTROL_CAPABILITIES.sessionWake)) {
        throw new Error('当前连接未声明 session.wake');
      }
      externalAgg.setBindingWakeState(this.bus.store, binding.id, {
        state: 'provisioning',
        mode: binding.host,
        reason: '正在验证主动唤醒',
      });
      let result;
      try {
        // 唤醒验证要对齐宿主会话的真实 cwd（DSH 会话采用强校验工作目录），
        // 取当前主控所控团队的 workspace 作为验证环境。
        result = await this.wake(binding, {
          teamName: 'Agent Team 主动唤醒验证',
          count: 0,
          verification: true,
          workspace: externalAgg.controlledTeams(this.bus.store, binding.principal_id)[0]?.workspace,
        });
      } catch (error) {
        result = { supported: true, state: 'failed', reason: error.message };
      }
      const refreshed = externalAgg.binding(this.bus.store, binding.id);
      if (!result.supported) {
        externalAgg.setBindingWakeState(this.bus.store, binding.id, {
          state: 'unsupported',
          mode: binding.host,
          reason: result.reason ?? '宿主不支持主动唤醒',
        });
      } else if ((result.state ?? 'started') === 'started') {
        externalAgg.clearPullOnly(this.bus.store, binding.id);
        externalAgg.setBindingWakeState(this.bus.store, binding.id, {
          state: 'ready',
          mode: result.mode ?? binding.host,
          reason: null,
          fingerprint: result.fingerprint ?? null,
          verifiedAt: new Date().toISOString(),
          attempts: 0,
        });
        for (const team of externalAgg.controlledTeams(this.bus.store, binding.principal_id)) {
          this.scheduleWake(binding.principal_id, team.id);
        }
      } else if (result.state === 'failed') {
        externalAgg.setBindingWakeState(this.bus.store, binding.id, {
          state: 'degraded',
          mode: result.mode ?? binding.host,
          reason: result.reason ?? '主动唤醒验证失败',
          attempts: Number(binding.wake_attempts ?? 0) + 1,
        });
      } else {
        externalAgg.setBindingWakeState(this.bus.store, binding.id, {
          state: 'provisioning',
          mode: result.mode ?? binding.host,
          reason: result.reason ?? '队列已接受，等待宿主开始回合',
        });
      }
      return {
        wake: wake.wakeStatus(externalAgg.binding(this.bus.store, binding.id)),
        receipt: result,
        previous: wake.wakeStatus(refreshed),
      };
    }
    if (name === 'control_accept_pull_only') {
      externalAgg.acceptPullOnly(this.bus.store, binding.id);
      return { wake: wake.wakeStatus(externalAgg.binding(this.bus.store, binding.id)) };
    }
    if (name === 'control_status') return {
      binding: {
        id: binding.id,
        name: binding.name,
        host: binding.host,
        status: binding.status,
        surface: binding.surface,
        pullOnlyAccepted: Boolean(binding.pull_only_accepted),
      },
      capabilities,
      delivery: externalAgg.deliveryStatus(this.bus.store, binding.principal_id),
      decisions: externalAgg.pendingDecisions(this.bus.store, binding.principal_id).length,
      protocol,
      controlledTeams: externalAgg.teamsForBinding(this.bus.store, binding.id).length,
      wake: wake.wakeStatus(binding),
    };
    // 列表按「与当前主控会话建立过关系的团队」收口:独立主控会话互相看不到
    // 对方的团队;接管后的旧会话保留关系(active=false),凭精确团队 ID 仍可检视。
    if (name === 'control_teams') return {
      teams: externalAgg.teamsForBinding(this.bus.store, binding.id).map(team => ({
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
    if (name === 'team_create') {
      const created = await this.createTeam(binding, capabilities, args);
      let current = externalAgg.binding(this.bus.store, binding.id);
      if (wake.wakeStatus(current).state !== 'ready') {
        externalAgg.setBindingWakeState(this.bus.store, binding.id, {
          state: current.pull_only_accepted ? 'degraded' : 'provisioning',
          mode: current.wake_mode ?? current.host,
          reason: current.pull_only_accepted
            ? '用户已接受仅拉取模式'
            : '等待主动唤醒验证',
        });
        current = externalAgg.binding(this.bus.store, binding.id);
      }
      return {
        ...created,
        headless: wake.wakeStatus(current),
      };
    }

    if (name === 'team_activate') {
      if (typeof args.teamId !== 'string' || !args.teamId) throw new Error('需要 teamId');
      const group = this.bus.store.group(args.teamId);
      const now = new Date().toISOString();
      let assignment;
      if (externalAgg.relationFor(this.bus.store, group.id, binding.id)) {
        assignment = externalAgg.activateTeam(this.bus.store, {
          groupId: group.id,
          principalId: binding.principal_id,
          bindingId: binding.id,
          now,
        });
      } else {
        // 同用户凭精确团队 ID 直接接管(ADR 0010):确立关系、移交席位、
        // 留下可见事件、尽力唤醒旧主控,并把团队 workspace 跟到新会话目录。
        const takeover = externalAgg.takeoverTeam(this.bus.store, {
          groupId: group.id,
          principalId: binding.principal_id,
          bindingId: binding.id,
          now,
        });
        this.bus.notify(
          group.id,
          'user',
          `主控已切换到「${binding.name}」（${binding.host}）；此前的主控会话保留只读访问。`,
        );
        this.wakePreviousController(takeover.previousBindingId, group);
        if (surfaceFollowsConversation(binding.surface) && binding.controller_cwd) {
          externalAgg.requestControllerWorkspace(this.bus.store, {
            groupId: group.id,
            cwd: binding.controller_cwd,
            now,
          });
        }
        assignment = takeover.assignment;
      }
      this.scheduleWake(binding.principal_id, group.id);
      return {
        teamId: group.id,
        activeBindingId: binding.id,
        revision: assignment.revision,
      };
    }
    const writeTools = new Set([
      'team_send',
      'team_note',
      'team_tasks_set',
      'team_stop_member',
      'team_member_model',
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
    if (name === 'team_members') return {
      teamId: group.id,
      controllerId: binding.principal_id,
      members: await this.membersWithPolicy(group),
    };
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
      if (name === 'team_send') {
        const currentBinding = externalAgg.binding(this.bus.store, binding.id);
        const wakeState = wake.wakeStatus(currentBinding);
        if (wakeState.state !== 'ready' && !currentBinding.pull_only_accepted) {
          const error = new Error(`headless_not_ready: ${wakeState.reason ?? wakeState.state}`);
          error.code = 'headless_not_ready';
          error.details = { wake: wakeState };
          throw error;
        }
      }
      const to = args.to;
      const text = args.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 48000) throw new Error('消息正文无效');
      const target = this.bus.resolveRecipient(group.id, to);
      if (target.id === binding.principal_id) throw new Error('不能向主控自己发送团队消息');
      // 与成员 send、Panel team_send 同一道门禁：写库前核对目标成员当前有效能力，
      // 旧 file.* 词在此归一化；错误结构与无头既有 capability_required 语义保持一致。
      const hasRequirements = name === 'team_send'
        && ((Array.isArray(args.requiredCapabilities) && args.requiredCapabilities.length > 0)
          || args.minContextWindow !== undefined);
      let requirements = null;
      if (hasRequirements) {
        const checked = await this.bus.capabilities.assertDispatch({
          group,
          target,
          requiredCapabilities: args.requiredCapabilities,
          minContextWindow: args.minContextWindow,
        });
        requirements = checked.requirements;
      }
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
        requiredCapabilities: requirements?.requiredCapabilities ?? null,
        minContextWindow: requirements?.minContextWindow ?? null,
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
    if (name === 'team_member_model') {
      this.bus.collaboration.requireCommunication(group.id);
      const member = this.bus.resolveMember(group.id, args.member);
      return this.bus.setMemberModel(group.id, member.id, {
        model: args.model,
        model_provider: args.modelProvider ?? null,
        reasoning_effort: args.reasoningEffort ?? null,
      });
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
      messagesAgg.clearAwaiting(this.bus.store, message.id);
    });
    this.scheduleWake(principalId, message.group_id);
    return true;
  }

  /** 唤醒调度委托：实现在 control/wake-scheduler.mjs（首参 this）。 */
  wakePreviousController(previousBindingId, group) {
    return wake.wakePreviousController(this, previousBindingId, group);
  }

  scheduleWake(principalId, groupId) {
    return wake.scheduleWake(this, principalId, groupId);
  }

  async wakePending(principalId, groupId) {
    return wake.wakePending(this, principalId, groupId);
  }

  recordWakeFailure(options) {
    return wake.recordWakeFailure(this, options);
  }

  requestDecision({ groupId, memberId, payload }) {
    const controller = this.bus.teamController(groupId);
    if (controller.kind !== 'external_agent') return null;
    const binding = externalAgg.activeBindingForTeam(this.bus.store, controller.id, groupId);
    if (!binding || !identity.hasElicitation(identity.bindingCapabilities(binding))) {
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

  async createTeam(binding, capabilities, args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name || name.length > 200) throw new Error('团队名称无效');
    // ADR 0012:桌面主控会话不注册第二份目录,团队 workspace 就是该会话的
    // 当前工作目录;CLI 连接沿用显式传入的 workspace。
    const workspaceSource = surfaceFollowsConversation(binding.surface) ? binding.controller_cwd : args.workspace;
    if (typeof workspaceSource !== 'string' || !workspaceSource) {
      throw new Error(surfaceFollowsConversation(binding.surface) ? '主控会话尚未提供工作目录' : '工作目录无效');
    }
    let workspace;
    try {
      workspace = realpathSync(resolve(workspaceSource));
      if (!statSync(workspace).isDirectory()) throw new Error('工作目录无效');
    } catch {
      throw new Error('工作目录无效');
    }
    // ADR 0012 跟随语义:桌面会话的 controller_cwd 来自该会话自身(显式 env 或
    // MCP 子进程 cwd),与会话同一信任层级;安装时无从知晓会话会开在哪个目录,
    // 声明的 roots 只是上界猜测。把会话自己的目录并入有效 roots,团队才能跟随
    // 会话开在注册根之外(2026-11-21 验收实测:桌面会话开在仓库而 roots=[主目录]
    // 时建团被拒,显式传 workspace 也被忽略)。cwd 已消失时跳过,留给原语义拒绝。
    let desktopCwd = null;
    if (surfaceFollowsConversation(binding.surface) && binding.controller_cwd) {
      try {
        desktopCwd = realpathSync(binding.controller_cwd);
        if (!statSync(desktopCwd).isDirectory()) desktopCwd = null;
      } catch {
        desktopCwd = null;
      }
    }
    const workspaceRoots = [...new Set([
      ...capabilities.workspaceRoots.map(root => {
        try {
          const canonical = realpathSync(root);
          return statSync(canonical).isDirectory() ? canonical : root;
        } catch {
          return root;
        }
      }),
      ...(desktopCwd ? [desktopCwd] : []),
    ])];
    assertControlWorkspace({ ...capabilities, workspaceRoots }, workspace);
    const policy = assertControlPolicy(capabilities, args.policy ?? 'read-only');
    const workflowTemplate = normalizeWorkflowTemplateId(args.workflowTemplate);
    const people = identity.normalizedMembers(args.members);
    const operationId = typeof args.operationId === 'string' && /^[\w-]{1,128}$/.test(args.operationId)
      ? args.operationId
      : null;
    if (args.operationId !== undefined && !operationId) throw new Error('operationId 无效');
    await this.assignMemberSelections(people);
    const payload = JSON.stringify({
      principalId: binding.principal_id,
      name,
      workspace,
      policy,
      allowShell: args.allowShell === true,
      people,
      charter: args.charter ?? null,
      ...(workflowTemplate ? { workflowTemplate } : {}),
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
      // 群策略是成员级上限的硬天花板:越级配置同步拒绝。
      normalizeMemberPolicyPatch(policy, {
        policyCeiling: person.policyCeiling,
        allowShell: person.allowShell,
        allowBrowser: person.allowBrowser,
      });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const provisioned = provisionMemberWorktrees({
      dataDir: this.bus.store.directory,
      groupId: id,
      workspace,
      groupPolicy: policy,
      people: people.map(person => ({ ...person, role: 'member' })),
      idFactory: () => randomUUID(),
    });
    try {
      this.bus.store.transaction(() => {
        teamsAgg.insertGroup(this.bus.store, {
          id,
          name,
          workspace,
          created: now,
          charter: typeof args.charter === 'string' && args.charter.trim() ? args.charter.trim() : null,
          policy,
          allowShell: args.allowShell === true ? 1 : 0,
          workflowTemplate,
        });
        teamsAgg.insertExternalController(this.bus.store, {
          groupId: id,
          principalId: binding.principal_id,
          bindingId: binding.id,
          now,
        });
        externalAgg.establishRelation(this.bus.store, {
          groupId: id,
          principalId: binding.principal_id,
          bindingId: binding.id,
          origin: 'creator',
          created: now,
          now,
        });
        for (const person of provisioned.members) {
          teamsAgg.insertMember(this.bus.store, {
            id: person.id,
            groupId: id,
            name: person.name,
            host: person.host,
            role: 'member',
            selection: person.selection ?? this.bus.defaultModelSelection(person.host),
            policyCeiling: person.policyCeiling ?? null,
            allowShell: person.allowShell === undefined ? null : person.allowShell,
            allowBrowser: person.allowBrowser === true,
            workspaceMode: person.workspaceMode,
            worktreePath: person.worktreePath,
            worktreeBranch: person.worktreeBranch,
          });
          this.bus.collaboration.reserveMemberName(id, person.id, person.name);
        }
        if (operationId) {
          externalAgg.recordTeamCreateOperation(this.bus.store, { principalId: binding.principal_id, operationId, payload, groupId: id, created: now });
        }
      });
    } catch (error) {
      provisioned.rollback();
      throw error;
    }
    const createdMembers = this.bus.members(id);
    for (const member of createdMembers) await this.executionPolicyFor(this.bus.store.group(id), member);
    for (const member of createdMembers) if (!member.profile) this.bus.introduce(member);
    return { team: this.bus.store.group(id), controllerId: binding.principal_id, replayed: false };
  }

  async assignMemberSelections(people) {
    if (!people.some(person => person.model)) return;
    const hostAvailable = value => people.every(person =>
      value.hosts.some(item => item.host === person.host && item.ok && item.catalog));
    let catalog = await this.bus.modelCatalog({ refresh: true });
    if (!hostAvailable(catalog)) {
      await new Promise(resolve => setTimeout(resolve, 200));
      catalog = await this.bus.modelCatalog({ refresh: true });
    }
    for (const person of people) {
      if (!person.model) continue;
      const hostCatalog = catalog.hosts.find(item => item.host === person.host && item.ok && item.catalog);
      if (!hostCatalog) throw new Error(`宿主 ${person.host} 没有可用模型目录`);
      const model = hostCatalog.catalog.models.find(item => item.id === person.model);
      if (!model) throw new Error('选择的模型不在该成员宿主目录中');
      const effort = person.reasoningEffort
        || model.defaultReasoningEffort
        || model.reasoningEfforts[0]?.id
        || null;
      if (!effort || (model.reasoningEfforts.length && !model.reasoningEfforts.some(item => item.id === effort))) {
        throw new Error('模型思考强度不受支持');
      }
      person.selection = {
        model_provider: model.provider ?? null,
        model: model.id,
        reasoning_effort: effort,
      };
    }
  }

  async executionPolicyFor(group, member) {
    return this.bus.capabilities.executionPolicyFor(group, member);
  }

  async membersWithPolicy(group) {
    return this.bus.capabilities.memberCards(group, { persist: true });
  }

  async snapshot(group, principalId) {
    const binding = externalAgg.activeBindingForTeam(this.bus.store, principalId, group.id);
    const controllerCard = await this.bus.capabilities.controllerCard(group).catch(() => null);
    return {
      team: group,
      controller: { id: principalId, kind: 'external_agent', capabilityCard: controllerCard },
      headless: binding ? wake.wakeStatus(binding) : { state: 'unsupported', mode: null, reason: '没有 active controller binding' },
      members: await this.membersWithPolicy(group),
      communication: this.bus.groupSummary(group.id),
      tasks: this.bus.agentTasksView(group.id),
    };
  }
}

// 兼容导出：既有调用方仍从 control-plane.mjs 导入这些名字。
export { createExternalIdentity } from './control/identity.mjs';
export { wakeBackoffMs } from './control/wake-scheduler.mjs';
export { toolsForControlCapabilities } from './control/tools.mjs';
