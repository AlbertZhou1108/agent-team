import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectionProbe, exchange } from '../../host-runtime/probe.mjs';
import { mcpConfig } from '../../host-runtime/process.mjs';
import { executionPolicy, policyObservation } from '../../hosts/policies.mjs';
import { modelCatalog } from '../../hosts/catalog.mjs';
import { capability, capabilities, executionConditions, tokenConditions } from '../../capability-contract.mjs';
import { telemetryObservation } from '../../observation.mjs';
import { createZcodeProtocol, headlessInteractionReply } from './protocol.mjs';
import { resolveZcodeLaunch } from './wake.mjs';
import { memberExecutionCapabilities } from '../../hosts/execution.mjs';

const ZCODE_EFFORTS = new Set(['disabled', 'low', 'high', 'max']);

/** 未启用 shell 时，执行边界按 ZCode 会话权限模式解释。 */
export const ZCODE_TRAITS = Object.freeze({
  noShellReason: '未启用 shell；执行边界依赖 ZCode 会话权限模式',
});

/** zcode 的遥测能力声明：桶来自 turn/model_request 完成事件的宿主用量。 */
export function zcodeCapabilities() {
  const turnUsage = ['turn.completed payload.usage'];
  return capabilities('zcode', {
    inputTokensTotal: capability('direct', 'zcode.turn_completed', turnUsage, [...tokenConditions, 'usage.inputTokens 为完整输入（含缓存命中）']),
    uncachedInputTokens: capability('derived', 'zcode.turn_completed', ['inputTokensTotal', 'cacheReadTokens'], [...tokenConditions, 'uncachedInputTokens = inputTokensTotal - cacheReadTokens']),
    cacheReadTokens: capability('direct', 'zcode.turn_completed', turnUsage, tokenConditions),
    cacheWriteTokens: capability('direct', 'zcode.turn_completed', turnUsage, tokenConditions),
    outputTokens: capability('direct', 'zcode.turn_completed', turnUsage, tokenConditions),
    totalTokens: capability('direct', 'zcode.turn_completed', turnUsage, [...tokenConditions, '宿主直接报告 totalTokens']),
    cacheReadRatio: capability('derived', 'query.aggregate', ['cacheReadTokens', 'inputTokensTotal'], ['同一完整样本集合', '输入为 0 时不生成比例']),
    executionWallMs: capability('derived', 'framework.measured', ['run start/settle'], executionConditions),
    hostTurnWallMs: capability('derived', 'zcode.turn_events', ['turn.started 时间戳', 'turn.completed 时间戳'], executionConditions),
    lastRequestInputTokens: capability('direct', 'zcode.model_request_completed', ['model_request_completed payload.usage.inputTokens'], tokenConditions),
    contextWindowTokens: capability('direct', 'zcode.model_request_completed', ['model_request_completed payload.contextWindow'], tokenConditions),
    lastRequestInputRatio: capability('derived', 'query.aggregate', ['lastRequestInputTokens', 'contextWindowTokens'], ['模型路由匹配且窗口大于 0']),
  });
}

/** 连接探测：完成启动握手并成功列出会话即视为可用，不消耗模型额度。 */
export function probeZcode(command, { args, env, ...options } = {}) {
  let listed = false;
  return exchange(command, args ?? ['app-server', '--stdio'], {
    ...options,
    env: { ...process.env, ...env },
    receive(line, send) {
      const row = JSON.parse(line);
      if (row.method === 'startup/storagePath') {
        send({ method: 'startup/storagePathReady' });
        return;
      }
      if (row.id && row.method) {
        send({ id: row.id, result: {} });
        return;
      }
      if (row.method?.startsWith('startup/')) {
        if (!listed) {
          listed = true;
          send({ id: 1, method: 'session/list', params: {} });
        }
        return;
      }
      if (row.id === 1) {
        if (row.error) throw new Error(row.error.message || 'ZCode 会话列表响应无效');
        return { connected: true };
      }
    },
  });
}

/** 从会话状态补丁提取模型目录。 */
function catalogFromState(available, lastUsed) {
  const models = available.map(item => ({
    key: `${item.ref?.providerId ?? ''}:${item.ref?.modelId ?? item.id}`,
    id: item.ref?.modelId ?? item.id,
    label: item.label ?? item.ref?.modelId ?? item.id,
    description: item.providerLabel ?? undefined,
    provider: item.ref?.providerId ?? null,
    contextWindow: item.contextWindow,
    reasoningEfforts: (item.reasoning?.levels ?? []).map(level => ({ id: level.value, label: level.label })),
    defaultReasoningEffort: item.reasoning?.defaultLevel ?? null,
  }));
  const used = lastUsed ?? {};
  const fallback = models[0] ?? null;
  const preferred = models.find(item =>
    item.provider === used.providerId && item.id === used.modelId) ?? null;
  const defaultModel = preferred?.id ?? fallback?.id ?? null;
  return models.map(item => ({ ...item, isDefault: item.id === defaultModel && item === (preferred ?? fallback) }));
}

/** 模型目录探测：在隔离 scratch HOME 里建临时会话并读取 model.available，不消耗模型额度。 */
async function zcodeModelCatalog(launch, home, options = {}) {
  mkdirSync(join(home, '.zcode', 'cli'), { recursive: true, mode: 0o700 });
  let available = null;
  let lastUsed = null;
  const protocol = createZcodeProtocol({
    command: launch.command,
    args: launch.args,
    env: { ...launch.env, HOME: home },
    // 启动期反向请求也要按无头默认应答：新版 app-server 校验
    // nativeSearchEnhancementsEnabled 必须是布尔值，回 {} 会让目录探测失败。
    onRequest: headlessInteractionReply,
    onNotification(row) {
      if (row.method !== 'state.updated') return;
      const model = row.params?.patch?.model;
      if (Array.isArray(model?.available) && model.available.length) {
        available = model.available;
        lastUsed = model.lastUsed ?? model.current?.ref ?? null;
      }
    },
  });
  try {
    await protocol.ready;
    const created = await protocol.request('session/create', {
      workspace: { workspacePath: home, workspaceKey: home },
      persistence: 'immediate',
    }, { timeout: 30000 });
    // 新版 app 不再推送 state.updated，模型目录随 session/create 返回在
    // settings.model 里（结构与旧版 patch.model 一致）；state.updated 兜底旧版。
    const settingsModel = created?.settings?.model;
    if (!available && Array.isArray(settingsModel?.available) && settingsModel.available.length) {
      available = settingsModel.available;
      lastUsed = settingsModel.lastUsed ?? settingsModel.current?.ref ?? settingsModel.current ?? null;
    }
    const deadline = Date.now() + 15000;
    while (!available) {
      options.signal?.throwIfAborted();
      if (Date.now() > deadline) throw new Error('ZCode 未提供模型目录');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    await protocol.request('session/close', { sessionId: created?.session?.sessionId }, { timeout: 5000 }).catch(() => {});
    const models = catalogFromState(available, lastUsed);
    // modelCatalog 的 defaultModel 按 key 匹配校验；defaultSelection 也先按 key 找。
    const defaultModel = models.find(item => item.isDefault)?.key ?? null;
    return modelCatalog({
      host: 'zcode',
      source: 'zcode.session_state',
      models,
      defaultModel,
    });
  } finally {
    await protocol.stop();
  }
}

/**
 * 对 agent_team MCP server 做 workspace 级授信：无头协议会话里没人点审批，
 * 未授信 server 的工具调用会被权限系统拒绝（Permission request failed）。
 * 授信状态持久于 workspace；已授信则跳过。
 */
async function trustAgentTeamServer(protocol, workspace) {
  const listed = await protocol.request('mcp/list', { workspace }, { timeout: 30000 });
  const server = listed?.statuses?.agent_team;
  if (!server) throw new Error('ZCode 会话未加载 agent_team MCP server；请检查 endpoint 配置');
  const trust = server.workspaceTrust;
  if (!trust?.declarationDigest || trust.trusted === true) return;
  const result = await protocol.request('workspace/mcp/trust', {
    workspace,
    serverName: 'agent_team',
    declarationDigest: trust.declarationDigest,
    trusted: true,
  }, { timeout: 30000 });
  if (result?.accepted === false) {
    throw new Error(`agent_team MCP server 授信失败: ${result.reasonCode ?? 'unknown'}`);
  }
}

export function createZcodeHost({
  directory, socketPath, command = 'zcode', model, reasoningEffort,
}) {
  if (reasoningEffort && !ZCODE_EFFORTS.has(reasoningEffort)) throw new Error(`ZCode 思考强度无效: ${reasoningEffort}`);
  const lifecycle = {
    installationStatus: () => ({ installing: false }),
    async checkStatus() {
      try {
        resolveZcodeLaunch({ command });
        return { status: 'available' };
      } catch (error) {
        return { status: 'missing', reason: error.message };
      }
    },
    async install() {
      throw new Error('ZCode 不可自动安装；请安装 ZCode 桌面应用，或设置 AGENT_TEAM_ZCODE_COMMAND / connect --command');
    },
  };
  const probe = connectionProbe(lifecycle, signal => {
    const launch = resolveZcodeLaunch({ command });
    return probeZcode(launch.command, { args: launch.args, env: launch.env, signal });
  });
  return {
    ...probe,
    installationStatus: lifecycle.installationStatus,
    checkStatus: lifecycle.checkStatus,
    install: lifecycle.install,
    telemetryCapabilities: zcodeCapabilities(),
    executionCapabilities({ mode, allowShell }) {
      return memberExecutionCapabilities(ZCODE_TRAITS, { mode, allowShell });
    },
    supportsPanelAccess({ access }) {
      return ['read-only', 'workspace-write', 'full-access'].includes(access)
        ? { supported: true }
        : { supported: false, reason: '未知私人访问级别' };
    },
    async listModels(options = {}) {
      const launch = resolveZcodeLaunch({ command });
      return zcodeModelCatalog(launch, join(directory, 'zcode-catalog-home'), options);
    },
    async run(context) {
      const { endpoint, prompt, instructions, onSession, onAccepted, onTextDelta, onTelemetry, onModel, onSelection, onPolicy, signal, turnId, workspace } = context;
      if ((context.attachments ?? []).length) throw new Error('ZCode 会话暂不支持附件输入');
      const launch = resolveZcodeLaunch({ command, cwd: workspace });
      // 每 endpoint 独立 HOME：会话库与 agent_team MCP 配置都在该目录内，互不串扰。
      const home = join(directory, 'zcode-endpoints', endpoint.id);
      mkdirSync(join(home, '.zcode', 'cli'), { recursive: true, mode: 0o700 });
      const mcp = mcpConfig({ socketPath, endpoint, turnId });
      writeFileSync(join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({
        mcp: { servers: { agent_team: { command: mcp.command, args: mcp.args, env: mcp.env } } },
      }), { mode: 0o600 });
      const policy = executionPolicy(context);
      onPolicy?.(policyObservation('zcode', policy, { mode: 'zcode-permission', sandbox: null, panelAccess: context.policy?.access ?? null }));
      const selectedModel = context.modelSelection?.model ?? model;
      const selectedEffort = context.modelSelection?.reasoning_effort ?? reasoningEffort;
      if (selectedModel || selectedEffort) {
        onModel({
          phase: 'requested', model: selectedModel ?? null, reasoningEffort: selectedEffort ?? null,
          source: context.modelSelection ? 'member.selection' : 'adapter.config',
        });
      }
      let sessionId = null;
      let wakeTurnId = null;
      let turnStartedAt = null;
      let deltaText = '';
      let completedResolve;
      let completedReject;
      const completed = new Promise((resolve, reject) => {
        completedResolve = resolve;
        completedReject = reject;
      });
      completed.catch(() => {});
      const emitRequestTelemetry = payload => {
        const usage = payload.usage ?? {};
        const inputTotal = Number.isFinite(usage.inputTokens) ? usage.inputTokens : undefined;
        const cacheRead = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : undefined;
        const uncached = inputTotal !== undefined && cacheRead !== undefined ? inputTotal - cacheRead : undefined;
        onTelemetry?.(telemetryObservation({
          source: 'zcode.model_request_completed', scope: 'request', aggregation: 'snapshot',
          requestId: payload.requestId ?? null,
          usage: {
            ...(inputTotal !== undefined ? { inputTokensTotal: inputTotal } : {}),
            ...(uncached !== undefined ? { uncachedInputTokens: uncached } : {}),
            ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
            ...(Number.isFinite(usage.cacheWriteTokens) ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
            ...(Number.isFinite(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
            ...(Number.isFinite(payload.contextWindow) ? { contextWindowTokens: payload.contextWindow } : {}),
            ...(inputTotal !== undefined ? { lastRequestInputTokens: inputTotal } : {}),
          },
          quality: {
            inputTokensTotal: 'host_reported', uncachedInputTokens: 'derived', cacheReadTokens: 'host_reported',
            outputTokens: 'host_reported', contextWindowTokens: 'host_reported', lastRequestInputTokens: 'host_reported',
          },
          formula: { uncachedInputTokens: 'inputTokensTotal - cacheReadTokens', lastRequestInputTokens: 'usage.inputTokens' },
          context: payload.modelId ? {
            model: { provider: 'zcode', model: payload.modelId, source: 'zcode.model_request_completed', observedAt: new Date().toISOString() },
          } : undefined,
        }));
      };
      const emitTurnTelemetry = (payload, turnId, startedAt, endedAt) => {
        const usage = payload.usage ?? {};
        const inputTotal = Number.isFinite(usage.inputTokens) ? usage.inputTokens : undefined;
        const cacheRead = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : undefined;
        const uncached = inputTotal !== undefined && cacheRead !== undefined ? inputTotal - cacheRead : undefined;
        const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : undefined;
        const wallMs = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, Math.round(endedAt - startedAt)) : undefined;
        onTelemetry?.(telemetryObservation({
          source: 'zcode.turn_completed', scope: 'turn', aggregation: 'delta',
          requestId: turnId ?? null,
          usage: {
            ...(inputTotal !== undefined ? { inputTokensTotal: inputTotal } : {}),
            ...(uncached !== undefined ? { uncachedInputTokens: uncached } : {}),
            ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
            ...(Number.isFinite(usage.cacheWriteTokens) ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
            ...(output !== undefined ? { outputTokens: output } : {}),
            ...(Number.isFinite(usage.totalTokens) ? { totalTokens: usage.totalTokens } : {}),
            ...(wallMs !== undefined ? { hostTurnWallMs: wallMs } : {}),
          },
          quality: {
            inputTokensTotal: 'host_reported', uncachedInputTokens: 'derived', cacheReadTokens: 'host_reported',
            outputTokens: 'host_reported', totalTokens: 'host_reported', hostTurnWallMs: 'derived',
          },
          formula: {
            uncachedInputTokens: 'inputTokensTotal - cacheReadTokens',
            hostTurnWallMs: 'turn.completed 时间戳 - turn.started 时间戳',
          },
          completeness: {
            inputTokensTotal: inputTotal !== undefined ? 'complete' : 'unknown',
            uncachedInputTokens: uncached !== undefined ? 'complete' : 'unknown',
            cacheReadTokens: cacheRead !== undefined ? 'complete' : 'unknown',
            outputTokens: output !== undefined ? 'complete' : 'unknown',
            totalTokens: Number.isFinite(usage.totalTokens) ? 'complete' : 'unknown',
            hostTurnWallMs: wallMs !== undefined ? 'complete' : 'unknown',
          },
          attempt: { id: String(turnId ?? sessionId ?? 'zcode-turn'), state: 'succeeded' },
        }));
      };
      const protocol = createZcodeProtocol({
        command: launch.command,
        args: launch.args,
        env: { ...launch.env, HOME: home },
        onRequest: headlessInteractionReply,
        onNotification(row) {
          if (row.method !== 'session/event' || row.params?.sessionId !== sessionId) return;
          const { type, payload, timestamp, turnId: eventTurnId } = row.params;
          if (type === 'turn.started') {
            turnStartedAt ??= timestamp;
            wakeTurnId ??= eventTurnId ?? null;
          }
          if (type === 'text_delta' && typeof payload?.delta === 'string') {
            deltaText += payload.delta;
            onTextDelta?.(payload.delta, {
              assistantMessageId: payload.assistantMessageId ?? null,
              done: payload.done ?? null,
              nativeTurnId: eventTurnId ?? null,
            });
          }
          if (type === 'model_request_completed' && payload) {
            if (payload.modelId) onModel({ phase: 'assistant', model: payload.modelId, provider: 'zcode', source: 'zcode.model_request_completed' });
            emitRequestTelemetry(payload);
          }
          if (type === 'turn.completed') {
            if (payload?.usage) emitTurnTelemetry(payload, wakeTurnId, turnStartedAt, timestamp);
            if (payload?.modelId) onModel({ phase: 'usage', models: [payload.modelId], provider: 'zcode', source: 'zcode.turn_completed' });
            completedResolve(payload ?? {});
          }
        },
      });
      signal.addEventListener('abort', () => {
        if (sessionId) protocol.request('session/stop', { sessionId }, { timeout: 10000 }).catch(() => {});
        // stop 之后可能不再有 turn.completed；回合取消由 run 以拒绝收尾，状态机交给框架。
        completedReject(Object.assign(new Error('回合已中断'), { isAbort: true }));
      }, { once: true });
      let turnTimer = null;
      try {
        signal.throwIfAborted();
        await protocol.ready;
        if (endpoint.session) {
          sessionId = endpoint.session;
          await protocol.request('session/resume', { sessionId }, { timeout: 60000 });
          onSession(sessionId);
        } else {
          const created = await protocol.request('session/create', {
            workspace: { workspacePath: workspace, workspaceKey: workspace },
            persistence: 'immediate',
          }, { timeout: 60000 });
          sessionId = created?.session?.sessionId;
          if (!sessionId) throw new Error('ZCode 会话创建未返回 sessionId');
          onSession(sessionId);
        }
        if (selectedModel) {
          await protocol.request('session/setModel', {
            sessionId,
            model: { providerId: context.modelSelection?.model_provider ?? null, modelId: selectedModel },
          }, { timeout: 30000 });
        }
        if (selectedEffort) {
          await protocol.request('session/setThoughtLevel', { sessionId, thoughtLevel: selectedEffort }, { timeout: 30000 });
        }
        if (selectedModel || selectedEffort) {
          onSelection?.({ model: selectedModel ?? null, reasoning_effort: selectedEffort ?? null });
        }
        await trustAgentTeamServer(protocol, { workspacePath: workspace, workspaceKey: workspace });
        await protocol.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, { timeout: 30000 });
        const content = instructions ? `${instructions}\n\n当前输入：\n${prompt}` : prompt;
        const accepted = await protocol.request('session/send', { sessionId, content }, { timeout: 60000 });
        if (accepted?.accepted === false) throw new Error('ZCode 会话拒绝回合输入');
        // session/send 的 accepted 是经服务端确认的持久入队回执，与 codex turn/start 同语义。
        onAccepted();
        turnTimer = setTimeout(() => {
          if (sessionId) protocol.request('session/stop', { sessionId }, { timeout: 10000 }).catch(() => {});
          completedReject(Object.assign(new Error('ZCode 回合超过 15 分钟，已请求停止，结果待核实'), { runtimeUnknown: true }));
        }, 900000);
        const turn = await completed;
        const final = typeof turn?.response === 'string' && turn.response.trim()
          ? turn.response
          : deltaText;
        if (!final?.trim()) throw new Error('ZCode 未返回可确认的结果');
        return final;
      } finally {
        clearTimeout(turnTimer);
        await protocol.stop();
      }
    },
  };
}
