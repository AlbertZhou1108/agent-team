/**
 * 外部主控身份层：凭据散列、binding 能力声明、身份创建，以及激活连接解析与鉴权。
 *
 * 原为 `control-plane.mjs` 的顶层函数与 `ControlPlane` 方法；方法抽成首参 `control`
 * 的模块函数后，类保留同名委托。需要调度唤醒时经 `control.scheduleWake(...)` 委托，
 * 不 import `wake-scheduler.mjs`（唤醒层单向依赖本模块，避免循环）。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CONTROL_CAPABILITIES,
  CONTROL_PROTOCOL_VERSION,
  assertControllerCapabilities,
  normalizeControlCapabilities,
  supportsControlCapability,
} from '../control-capabilities.mjs';
import * as externalAgg from '../aggregates/external-control.mjs';
import { nodeRunner } from '../runtime.mjs';
import { HOST_DEFINITIONS, surfaceFollowsConversation } from '../hosts/definitions.mjs';
import { protocolState } from './tools.mjs';

export function keyHash(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function normalizedMembers(value) {
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

export function bindingCapabilities(row) {
  // 声明即有效：不再与探测结果取交集（v19 起移除 probed_capabilities）。
  return normalizeControlCapabilities(JSON.parse(row.declared_capabilities));
}

export function hasElicitation(capabilities) {
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
export function resolveActivationBinding(control, activation, hostSession) {
  const threadId = typeof hostSession === 'string' ? hostSession.trim() : '';
  const identity = HOST_DEFINITIONS.get(activation.host)?.desktopConversationIdentity ?? 'thread';
  if (identity === 'app') {
    return control.resolveThreadBinding(activation, '应用级');
  }
  if (!threadId) {
    // 桌面聊天宿主的 MCP 子进程不注入线程身份(实测 Codex Desktop 26.x):
    // 回落到该激活连接最近绑定的会话,让 bind-session 后的后续调用可用;
    // 一次都没有绑定时,报错引导会话内完成显式绑定。
    const latest = control.latestBoundConversation(activation);
    if (latest) return latest;
    throw new Error(identity === 'manual'
      ? '该桌面宿主不会向 MCP 子进程注入会话身份;请在桌面会话内运行 bind-session 显式绑定后再调用'
      : '桌面会话尚未绑定:请在桌面会话的 shell 里运行 agent-team bind-session(凭据见插件 mcp 配置)绑定当前线程后再调用工具');
  }
  return control.resolveThreadBinding(activation, threadId);
}

/** 激活连接最近绑定的会话连接(桌面聊天 MCP 子进程无线程身份时的回落目标)。 */
export function latestBoundConversation(control, activation) {
  // 只回落到本激活连接解析出的会话(名字前缀限定),不同应用/不同接入不互相串。
  // 同毫秒绑定很常见:用 rowid 作 tiebreaker,保证「后绑定者赢」是确定性的。
  return control.bus.store.get(
    `SELECT * FROM external_client_bindings
     WHERE principal_id=? AND binding_kind='conversation' AND session IS NOT NULL
       AND name LIKE ? ESCAPE '\\'
     ORDER BY updated DESC, rowid DESC LIMIT 1`,
    activation.principal_id,
    activation.name.replace(/[\\%_]/g, c => `\\${c}`) + '%',
  ) ?? null;
}

export function resolveThreadBinding(control, activation, identityKey) {
  const name = `${activation.name}·${identityKey}`;
  const existing = externalAgg.bindingByName(control.bus.store, activation.principal_id, name);
  if (existing) {
    if (existing.binding_kind !== 'conversation') throw new Error('激活连接解析到了非会话连接');
    return existing;
  }
  const principal = externalAgg.principal(control.bus.store, activation.principal_id);
  const { binding } = createExternalIdentity(control.bus.store, {
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

export function authenticate(control, bindingId, key, protocolVersion = CONTROL_PROTOCOL_VERSION, hostSession = null, clearHostSession = false, hostCwd = null) {
  if (typeof bindingId !== 'string' || typeof key !== 'string' || !bindingId || !key) {
    throw new Error('缺少外部主控连接凭据');
  }
  const presented = externalAgg.binding(control.bus.store, bindingId);
  if (!presented || presented.status !== 'active' || presented.key_hash !== keyHash(key)) throw new Error('外部主控连接凭据无效');
  const row = presented.binding_kind === 'activation'
    ? control.resolveActivationBinding(presented, hostSession)
    : presented;
  const capabilities = bindingCapabilities(row);
  assertControllerCapabilities(capabilities);
  externalAgg.touchBinding(control.bus.store, row.id);
  if (control.bus.controlSocketPath) {
    const runner = nodeRunner();
    // 唤醒子进程携带的是「本次连接呈现的凭据」:CLI 场景即会话连接本身;
    // 桌面激活场景即激活连接——子进程在恢复的线程里运行,会重新上报宿主
    // 会话身份并解析回正确的会话连接(其 key 从不落明文)。
    const wakeConfig = {
      command: runner.command,
      args: [
        '--disable-warning=ExperimentalWarning',
        fileURLToPath(new URL('../cli.mjs', import.meta.url)),
        'mcp',
        '--socket', control.bus.controlSocketPath,
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
      externalAgg.setBindingWakeConfig(control.bus.store, row.id, wakeConfig);
      row.wake_config = serialized;
    }
  }
  const sessionChanged = clearHostSession
    ? externalAgg.clearBindingSession(control.bus.store, row.id)
    : externalAgg.setBindingSession(control.bus.store, row.id, hostSession);
  if (sessionChanged) {
    externalAgg.resetBindingWakeState(control.bus.store, row.id);
    row.session = clearHostSession ? null : String(hostSession).trim();
    for (const team of externalAgg.activeTeamsForBinding(control.bus.store, row.id)) {
      control.scheduleWake(row.principal_id, team.id);
    }
  }
  // 主控会话工作目录(ADR 0012):桌面会话的目录变化就是 Controller workspace
  // 变化,跟随到其席位团队;CLI binding 只记录事实,不自动移动团队目录。
  if (hostCwd && externalAgg.setBindingControllerCwd(control.bus.store, row.id, hostCwd)) {
    row.controller_cwd = hostCwd;
    if (surfaceFollowsConversation(row.surface)) {
      for (const team of externalAgg.activeTeamsForBinding(control.bus.store, row.id)) {
        externalAgg.requestControllerWorkspace(control.bus.store, { groupId: team.id, cwd: hostCwd });
      }
    }
  }
  return {
    binding: row,
    capabilities,
    protocol: protocolState(protocolVersion ?? CONTROL_PROTOCOL_VERSION),
  };
}
