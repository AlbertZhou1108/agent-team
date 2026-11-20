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
  normalizeControlCapabilities,
  supportsControlCapability,
} from './control-capabilities.mjs';
import * as externalAgg from './aggregates/external-control.mjs';
import * as teamsAgg from './aggregates/teams.mjs';
import * as messagesAgg from './aggregates/messages.mjs';
import * as conversationsAgg from './aggregates/conversations.mjs';
import { appendRoutedMessage, assertReplyTarget, readSharedMessages } from './tools/ops.mjs';
import { roleNameKey } from './collaboration.mjs';
import { validateToolValue } from './tools/schema.mjs';
import { deliverExternalWake } from './external-delivery.mjs';
import { nodeRunner } from './runtime.mjs';
import { wakeDriverFor } from './host-runtime/wake-drivers.mjs';
import { canonicalMemberCapabilityIds } from './hosts/capabilities.mjs';
import { HOST_DEFINITIONS, surfaceFollowsConversation } from './hosts/definitions.mjs';
import { controlToolDefinitions } from './control/tools.mjs';

const CONTROL_GUIDE = [
  'Agent Team 是宿主无关的协作控制面。',
  '所有团队操作都必须显式传 teamId；不要根据隐式当前团队猜测。',
  'send 会唤醒接收方，note 不唤醒。消息进入外部主控时使用 control_inbox 领取。',
  '外部主控只能访问自己控制的团队；权限不得高于当前绑定声明的 workspaceRoots 和 policies。',
  '支持主动唤醒的宿主必须先通过 control_wake_test 的真实唤醒才能派发工作；也可以显式接受 binding 级 Pull-only。',
  '成员模型由 team_create 或 team_member_model 按宿主实时目录选择，不静默回退。',
  'Group policy 是上限；成员有效策略与宿主能力取交集。team_send 可用 requiredCapabilities 阻止不兼容派单。',
  '需要用户决定时，向当前主控发 decision_request；由主控询问用户后通过 decision_answer 回复。',
  '同步工具失败以 isError 返回；不应伪造用户确认、送达或工作完成。',
].join('\n');

const WAKE_BACKOFF_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000]);

/** 主动唤醒失败后的退避间隔；超过三次返回 null（由 attempts 阈值转永久降级）。 */
export function wakeBackoffMs(attempts) {
  return WAKE_BACKOFF_MS[attempts - 1] ?? null;
}

function wakeStatus(binding) {
  if (!binding.session) {
    return { state: 'unsupported', mode: binding.wake_mode ?? binding.host, reason: '尚未发现可恢复的宿主 session' };
  }
  if (binding.pull_only_accepted) {
    return {
      state: 'degraded',
      mode: binding.wake_mode ?? binding.host,
      reason: binding.wake_reason ?? '用户已接受仅拉取模式',
    };
  }
  if (!bindingCapabilities(binding).capabilities.includes(CONTROL_CAPABILITIES.sessionWake)) {
    return { state: 'unsupported', mode: null, reason: '客户端未声明 session.wake，使用仅拉取模式' };
  }
  if (!wakeDriverFor(binding.host)) {
    return { state: 'unsupported', mode: binding.wake_mode ?? binding.host, reason: `宿主 ${binding.host} 尚未实现主动唤醒` };
  }
  if (binding.wake_state === 'ready') {
    return { state: 'ready', mode: binding.wake_mode ?? binding.host, reason: null };
  }
  if (binding.wake_state === 'degraded') {
    return {
      state: 'degraded',
      mode: binding.wake_mode ?? binding.host,
      reason: binding.wake_reason ?? '主动唤醒当前不可用',
    };
  }
  if (binding.wake_state === 'provisioning') {
    return {
      state: 'provisioning',
      mode: binding.wake_mode ?? binding.host,
      reason: binding.wake_reason ?? '正在验证主动唤醒',
    };
  }
  if (binding.wake_state === 'unsupported') {
    return {
      state: 'unsupported',
      mode: binding.wake_mode ?? binding.host,
      reason: binding.wake_reason ?? '宿主不支持主动唤醒',
    };
  }
  if (!binding.wake_config) {
    return { state: 'unverified', mode: binding.host, reason: '尚未建立主动唤醒配置' };
  }
  return {
    state: 'unverified',
    mode: binding.wake_mode ?? binding.host,
    reason: binding.wake_reason ?? '尚未通过真实主动唤醒验证',
  };
}

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
    return {
      name: String(item.name).trim(),
      host: String(item.host).trim(),
      ...(item.model !== undefined ? { model: String(item.model).trim() } : {}),
      ...(item.reasoningEffort !== undefined ? { reasoningEffort: String(item.reasoningEffort).trim() } : {}),
    };
  });
}

function bindingCapabilities(row) {
  // 声明即有效：不再与探测结果取交集（v19 起移除 probed_capabilities）。
  return normalizeControlCapabilities(JSON.parse(row.declared_capabilities));
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
  surface = 'cli',
  appId = null,
  bindingKind = 'conversation',
} = {}) {
  if (typeof principalName !== 'string' || !principalName.trim()) throw new Error('principalName 无效');
  if (typeof bindingName !== 'string' || !bindingName.trim()) throw new Error('bindingName 无效');
  if (typeof host !== 'string' || !host.trim()) throw new Error('host 无效');
  if (!['cli', 'desktop'].includes(surface)) throw new Error(`未知的连接 surface: ${surface}`);
  if (!['conversation', 'activation'].includes(bindingKind)) throw new Error(`未知的连接类型: ${bindingKind}`);
  const declaredCapabilities = assertControllerCapabilities(declared ?? {});
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
        appId,
        surface,
        bindingKind,
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
        appId,
        surface,
        bindingKind,
        created: now,
      });
    }
    return {
      principal: owner,
      binding: externalAgg.binding(store, id),
      key,
      capabilities: declaredCapabilities,
    };
  });
}

export class ControlPlane {
  constructor(bus, { wake = deliverExternalWake } = {}) {
    this.bus = bus;
    this.wake = wake;
    this.wakeSchedules = new Map();
    this.wakeInFlight = new Set();
  }

  /**
   * 激活连接解析:桌面宿主配置里只能放一条全局 MCP 凭据,激活连接按宿主的
   * 会话身份通道(desktopConversationIdentity)解析出真正的会话连接:
   * - thread:按宿主上报的线程身份一线程一连接(如 CODEX_THREAD_ID);
   * - manual:宿主不给子进程会话身份,须 bind_client_session 显式绑定后按
   *   绑定值解析,未绑定前拒绝执行工具;
   * - app:宿主没有会话身份通道,解析为应用级单连接;多会话隔离做不到,
   *   作为宿主限制如实呈现(配合 Pull-only 使用,如 Claude Desktop)。
   * 激活连接本身永不持有团队席位,也永不进入工具调用。
   */
  resolveActivationBinding(activation, hostSession) {
    const threadId = typeof hostSession === 'string' ? hostSession.trim() : '';
    const identity = HOST_DEFINITIONS.get(activation.host)?.desktopConversationIdentity ?? 'thread';
    if (identity === 'app') {
      return this.resolveThreadBinding(activation, '应用级');
    }
    if (!threadId) {
      // 桌面聊天宿主的 MCP 子进程不注入线程身份(实测 Codex Desktop 26.x):
      // 回落到该激活连接最近绑定的会话,让 bind-session 后的后续调用可用;
      // 一次都没有绑定时,报错引导会话内完成显式绑定。
      const latest = this.latestBoundConversation(activation);
      if (latest) return latest;
      throw new Error(identity === 'manual'
        ? '该桌面宿主不会向 MCP 子进程注入会话身份;请在桌面会话内运行 bind-session 显式绑定后再调用'
        : '桌面会话尚未绑定:请在桌面会话的 shell 里运行 agent-team bind-session(凭据见插件 mcp 配置)绑定当前线程后再调用工具');
    }
    return this.resolveThreadBinding(activation, threadId);
  }

  /** 激活连接最近绑定的会话连接(桌面聊天 MCP 子进程无线程身份时的回落目标)。 */
  latestBoundConversation(activation) {
    // 只回落到本激活连接解析出的会话(名字前缀限定),不同应用/不同接入不互相串。
    // 同毫秒绑定很常见:用 rowid 作 tiebreaker,保证「后绑定者赢」是确定性的。
    return this.bus.store.get(
      `SELECT * FROM external_client_bindings
       WHERE principal_id=? AND binding_kind='conversation' AND session IS NOT NULL
         AND name LIKE ? ESCAPE '\\'
       ORDER BY updated DESC, rowid DESC LIMIT 1`,
      activation.principal_id,
      activation.name.replace(/[\\%_]/g, c => `\\${c}`) + '%',
    ) ?? null;
  }

  resolveThreadBinding(activation, identityKey) {
    const name = `${activation.name}·${identityKey}`;
    const existing = externalAgg.bindingByName(this.bus.store, activation.principal_id, name);
    if (existing) {
      if (existing.binding_kind !== 'conversation') throw new Error('激活连接解析到了非会话连接');
      return existing;
    }
    const principal = externalAgg.principal(this.bus.store, activation.principal_id);
    const { binding } = createExternalIdentity(this.bus.store, {
      principalName: principal?.name,
      bindingName: name,
      host: activation.host,
      session: identityKey === '应用级' ? null : identityKey,
      declared: JSON.parse(activation.declared_capabilities),
      surface: 'desktop',
      appId: activation.app_id,
    });
    return binding;
  }

  authenticate(bindingId, key, protocolVersion = CONTROL_PROTOCOL_VERSION, hostSession = null, clearHostSession = false, hostCwd = null) {
    if (typeof bindingId !== 'string' || typeof key !== 'string' || !bindingId || !key) {
      throw new Error('缺少外部主控连接凭据');
    }
    const presented = externalAgg.binding(this.bus.store, bindingId);
    if (!presented || presented.status !== 'active' || presented.key_hash !== keyHash(key)) throw new Error('外部主控连接凭据无效');
    const row = presented.binding_kind === 'activation'
      ? this.resolveActivationBinding(presented, hostSession)
      : presented;
    const capabilities = bindingCapabilities(row);
    assertControllerCapabilities(capabilities);
    externalAgg.touchBinding(this.bus.store, row.id);
    if (this.bus.controlSocketPath) {
      const runner = nodeRunner();
      // 唤醒子进程携带的是「本次连接呈现的凭据」:CLI 场景即会话连接本身;
      // 桌面激活场景即激活连接——子进程在恢复的线程里运行,会重新上报宿主
      // 会话身份并解析回正确的会话连接(其 key 从不落明文)。
      const wakeConfig = {
        command: runner.command,
        args: [
          '--disable-warning=ExperimentalWarning',
          fileURLToPath(new URL('./cli.mjs', import.meta.url)),
          'mcp',
          '--socket', this.bus.controlSocketPath,
          '--client', presented.id,
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
      this.bus.store.run(
        `UPDATE external_client_bindings
         SET wake_state='unverified',wake_mode=host,wake_reason='宿主 session 已变化，需要重新验证主动唤醒',
             wake_fingerprint=NULL,wake_verified_at=NULL,wake_attempts=0,wake_next_attempt=NULL
         WHERE id=?`,
        row.id,
      );
      row.session = clearHostSession ? null : String(hostSession).trim();
      for (const team of externalAgg.activeTeamsForBinding(this.bus.store, row.id)) {
        this.scheduleWake(row.principal_id, team.id);
      }
    }
    // 主控会话工作目录(ADR 0012):桌面会话的目录变化就是 Controller workspace
    // 变化,跟随到其席位团队;CLI binding 只记录事实,不自动移动团队目录。
    if (hostCwd && externalAgg.setBindingControllerCwd(this.bus.store, row.id, hostCwd)) {
      row.controller_cwd = hostCwd;
      if (surfaceFollowsConversation(row.surface)) {
        for (const team of externalAgg.activeTeamsForBinding(this.bus.store, row.id)) {
          externalAgg.requestControllerWorkspace(this.bus.store, { groupId: team.id, cwd: hostCwd });
        }
      }
    }
    return {
      binding: row,
      capabilities,
      protocol: protocolState(protocolVersion ?? CONTROL_PROTOCOL_VERSION),
    };
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
        wake: wakeStatus(externalAgg.binding(this.bus.store, binding.id)),
        receipt: result,
        previous: wakeStatus(refreshed),
      };
    }
    if (name === 'control_accept_pull_only') {
      externalAgg.acceptPullOnly(this.bus.store, binding.id);
      return { wake: wakeStatus(externalAgg.binding(this.bus.store, binding.id)) };
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
      wake: wakeStatus(binding),
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
      if (wakeStatus(current).state !== 'ready') {
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
        headless: wakeStatus(current),
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
        const wake = wakeStatus(currentBinding);
        if (wake.state !== 'ready' && !currentBinding.pull_only_accepted) {
          const error = new Error(`headless_not_ready: ${wake.reason ?? wake.state}`);
          error.code = 'headless_not_ready';
          error.details = { wake };
          throw error;
        }
      }
      const to = args.to;
      const text = args.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 48000) throw new Error('消息正文无效');
      const target = this.bus.resolveRecipient(group.id, to);
      if (target.id === binding.principal_id) throw new Error('不能向主控自己发送团队消息');
      if (name === 'team_send' && Array.isArray(args.requiredCapabilities) && args.requiredCapabilities.length) {
        const member = this.bus.resolveMember(group.id, target.id);
        const policy = await this.executionPolicyFor(group, member);
        // 派单要求归一化到统一词汇；旧词（file.read 等）在此转换，避免调用方被迫改。
        const required = canonicalMemberCapabilityIds(args.requiredCapabilities);
        const missing = required.filter(capability => !policy.capabilities.includes(capability));
        if (missing.length) {
          const error = new Error(`capability_required: 成员 ${member.name} 缺少 ${missing.join(', ')}`);
          error.code = 'capability_required';
          error.details = { missingCapabilities: missing, executionPolicy: policy };
          throw error;
        }
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
      });
      if (name === 'team_send' && Array.isArray(args.requiredCapabilities)) {
        this.bus.store.run(
          'UPDATE messages SET required_capabilities=? WHERE id=?',
          JSON.stringify(args.requiredCapabilities),
          message.id,
        );
      }
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
      this.bus.store.run('UPDATE messages SET awaiting=0 WHERE id=?', message.id);
    });
    this.scheduleWake(principalId, message.group_id);
    return true;
  }

  /**
   * 接管后尽力唤醒旧主控(ADR 0010):让它有机会得知自己已只读。
   * 只是通知,不重试不调度;失败不打断接管本身。
   */
  wakePreviousController(previousBindingId, group) {
    if (!previousBindingId) return;
    const previous = externalAgg.binding(this.bus.store, previousBindingId);
    if (!previous?.session) return;
    Promise.resolve()
      .then(() => this.wake(previous, {
        teamName: `${group.name}（主控已移交）`,
        count: 0,
        workspace: group.workspace,
      }))
      .catch(error => {
        if (!this.bus.closing) console.error('[control] 唤醒前任主控失败:', error.message);
      });
  }

  scheduleWake(principalId, groupId) {
    const key = principalId;
    let state = this.wakeSchedules.get(key);
    if (!state) {
      state = { timer: null, groups: new Set() };
      this.wakeSchedules.set(key, state);
    }
    state.groups.add(groupId);
    if (state.timer || this.wakeInFlight.has(key)) return;
    const run = async () => {
      state.timer = null;
      const nextGroup = state.groups.values().next().value;
      if (!nextGroup || this.wakeInFlight.has(key)) return;
      state.groups.delete(nextGroup);
      this.wakeInFlight.add(key);
      try {
        await this.wakePending(principalId, nextGroup);
      } catch (error) {
        if (!this.bus.closing) console.error('[control] 外部唤醒调度失败:', error.message);
      } finally {
        this.wakeInFlight.delete(key);
        if (state.groups.size) {
          const remaining = state.groups.values().next().value;
          this.scheduleWake(principalId, remaining);
        }
        else this.wakeSchedules.delete(key);
      }
    };
    state.timer = setTimeout(run, 25);
    state.timer.unref?.();
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
    if (binding.wake_next_attempt && Date.parse(binding.wake_next_attempt) > Date.now()) {
      return { state: 'backoff', nextAttempt: binding.wake_next_attempt };
    }
    if (Number(binding.wake_attempts ?? 0) >= 3 && binding.wake_state !== 'ready') {
      return { state: 'degraded', reason: binding.wake_reason ?? '主动唤醒连续失败' };
    }
    if (binding.pull_only_accepted) {
      return { state: 'unsupported', count: rows.length, reason: 'binding 已接受仅拉取模式' };
    }
    externalAgg.markWake(this.bus.store, rows.map(row => row.id), {
      bindingId: binding.id,
      state: 'sending',
    });
    const group = this.bus.store.group(groupId);
    const teamName = group.name;
    try {
      const result = await this.wake(binding, {
        teamName,
        count: rows.length,
        workspace: group.workspace,
      });
      if (!result.supported) {
        externalAgg.markWake(this.bus.store, rows.map(row => row.id), {
          bindingId: binding.id,
          state: 'unsupported',
          error: result.reason ?? '宿主不支持主动唤醒',
        });
        externalAgg.setBindingWakeState(this.bus.store, binding.id, {
          state: 'unsupported',
          mode: binding.host,
          reason: result.reason ?? '宿主不支持主动唤醒',
        });
        return { state: 'unsupported', count: rows.length, reason: result.reason };
      }
      if (result.state === 'failed') {
        this.recordWakeFailure({
          binding,
          principalId,
          groupId,
          messageIds: rows.map(row => row.id),
          reason: result.reason ?? '主动唤醒失败',
          mode: result.mode ?? binding.host,
          fingerprint: result.fingerprint ?? null,
        });
        return { state: 'error', count: rows.length, reason: result.reason };
      }
      const now = new Date().toISOString();
      externalAgg.markWake(this.bus.store, rows.map(row => row.id), {
        bindingId: binding.id,
        state: 'sent',
      });
      externalAgg.setBindingWakeState(this.bus.store, binding.id, {
        state: (result.state ?? 'started') === 'started' ? 'ready' : 'provisioning',
        mode: result.mode ?? binding.host,
        reason: result.state === 'queued' ? '队列已接受，等待宿主开始回合' : null,
        fingerprint: result.fingerprint ?? null,
        verifiedAt: result.state === 'queued' ? null : now,
        attempts: 0,
        nextAttempt: null,
        now,
      });
      return { state: 'sent', count: rows.length };
    } catch (error) {
      this.recordWakeFailure({
        binding,
        principalId,
        groupId,
        messageIds: rows.map(row => row.id),
        reason: error.message,
      });
      return { state: 'error', count: rows.length, reason: error.message };
    }
  }

  /**
   * 主动唤醒失败的统一收尾：标记消息、降级 binding、按次数安排有界退避。
   *
   * 适配器"返回失败"（例如会话写锁被占用）与"抛异常"走同一条路径——
   * 两者都是暂时性失败，都应退避后重试，而不是只有异常才重试。
   * 第三次失败后由 wakePending 的 attempts 阈值转永久降级。
   */
  recordWakeFailure({ binding, principalId, groupId, messageIds, reason, mode = binding.host, fingerprint = null }) {
    const attempts = Number(binding.wake_attempts ?? 0) + 1;
    const backoff = wakeBackoffMs(attempts);
    const nextAttempt = backoff == null ? null : new Date(Date.now() + backoff).toISOString();
    externalAgg.markWake(this.bus.store, messageIds, {
      bindingId: binding.id,
      state: 'error',
      error: reason,
    });
    externalAgg.setBindingWakeState(this.bus.store, binding.id, {
      state: 'degraded',
      mode,
      reason: attempts >= 3 ? `主动唤醒连续失败：${reason}` : reason,
      fingerprint,
      attempts,
      nextAttempt,
    });
    if (backoff != null) {
      const timer = setTimeout(() => {
        this.scheduleWake(principalId, groupId);
      }, backoff);
      timer.unref?.();
    }
    return { attempts, backoff, nextAttempt };
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
    await this.assignMemberSelections(people);
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
      externalAgg.establishRelation(this.bus.store, {
        groupId: id,
        principalId: binding.principal_id,
        bindingId: binding.id,
        origin: 'creator',
        created: now,
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
          selection: person.selection ?? this.bus.defaultModelSelection(person.host),
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
    const host = this.bus.hosts.get(member.host);
    let report;
    if (host?.executionCapabilities) {
      report = await host.executionCapabilities({
        mode: group.policy,
        allowShell: group.allow_shell === 1,
        workspace: group.workspace,
      });
    } else {
      report = {
        effectivePolicy: group.policy === 'workspace-write' ? 'read-only' : group.policy,
        capabilities: group.policy === 'communication' ? [] : ['exec.read'],
        reason: group.policy === 'workspace-write' ? '宿主未声明工作区写边界保证' : null,
      };
    }
    let effective = report.effectivePolicy;
    let capabilities = [...new Set(report.capabilities ?? [])];
    let reason = report.reason ?? null;
    if (group.policy === 'communication') {
      effective = 'communication';
      capabilities = [];
      reason = '群策略仅允许通信';
    } else if (group.policy === 'read-only' && effective === 'workspace-write') {
      effective = 'read-only';
      capabilities = capabilities.filter(capability => capability === 'exec.read');
      reason = '群策略仅允许读取';
    }
    if (effective !== 'workspace-write') {
      capabilities = capabilities.filter(capability => capability === 'exec.read');
    }
    const policy = {
      requested: group.policy,
      effective,
      capabilities,
      reason,
    };
    const previousEffective = member.effective_policy ?? null;
    const previousCapabilities = member.capabilities ? JSON.parse(member.capabilities) : [];
    const capabilityChanged = previousEffective !== effective
      || JSON.stringify(previousCapabilities) !== JSON.stringify(capabilities);
    this.bus.store.run(
      'UPDATE members SET effective_policy=?,capabilities=?,capability_reason=? WHERE id=?',
      effective,
      JSON.stringify(capabilities),
      reason,
      member.id,
    );
    if (previousEffective !== null && capabilityChanged) {
      conversationsAgg.clearSessionsForMember(this.bus.store, member.id);
      this.bus.notify(group.id, member.id,
        `执行能力已更新为 ${effective}（${capabilities.join(', ') || '无项目能力'}）${reason ? `：${reason}` : ''}`);
    }
    return policy;
  }

  async membersWithPolicy(group) {
    const members = this.bus.members(group.id);
    const policies = await Promise.all(members.map(member => this.executionPolicyFor(group, member)));
    return members.map((member, index) => ({
      ...member,
      executionPolicy: policies[index],
      capabilities: policies[index].capabilities,
      effective_policy: policies[index].effective,
      capability_reason: policies[index].reason,
    }));
  }

  async snapshot(group, principalId) {
    const binding = externalAgg.activeBindingForTeam(this.bus.store, principalId, group.id);
    return {
      team: group,
      controller: { id: principalId, kind: 'external_agent' },
      headless: binding ? wakeStatus(binding) : { state: 'unsupported', mode: null, reason: '没有 active controller binding' },
      members: await this.membersWithPolicy(group),
      communication: this.bus.groupSummary(group.id),
      tasks: this.bus.agentTasksView(group.id),
    };
  }
}

export function toolsForControlCapabilities(capabilities) {
  const definitions = controlToolDefinitions();
  const canElicit = capabilities == null || hasElicitation(capabilities);
  const canWake = capabilities == null
    || supportsControlCapability(capabilities, CONTROL_CAPABILITIES.sessionWake);
  return definitions.filter(([name]) => (
    (canElicit || !['control_decisions', 'team_decision_answer'].includes(name))
    && (canWake || name !== 'control_wake_test')
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
