import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { executionPolicy, codexPolicyConfig, policyObservation } from './policies.mjs';
import { modelCatalog } from './catalog.mjs';
import { telemetryCapabilitiesFor, telemetryObservation } from '../telemetry.mjs';

export function createCodexHost({ command = 'codex', model, reasoningEffort }) {
  let child, init, nextId = 0, stderr = '', serverNames = [];
  const pending = new Map(), active = new Map(), ended = new Map(), waits = new Map();
  const usageBaselines = new Map(), turnBaselines = new Map(), emittedTurns = new Set();
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const fail = error => {
    error.runtimeUnknown = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    for (const entry of waits.values()) { clearTimeout(entry.timer); entry.reject(error); }
    waits.clear();
    child = null; init = null;
  };
  function request(method, params, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`Codex ${method} 超时，宿主执行状态待核实`), { runtimeUnknown: true })); }, timeout);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  async function receive(row) {
    if ('id' in row && !row.method) {
      const entry = pending.get(row.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(row.id); row.error ? entry.reject(new Error(row.error.message)) : entry.resolve(row.result); }
      return;
    }
    const context = active.get(row.params?.threadId);
    context?.onEvent(row);
    if (context?.onTelemetry) {
      if (row.method === 'thread/tokenUsage/updated') {
        const usage = row.params?.tokenUsage;
        const nativeTurnId = row.params?.turnId;
        const threadId = row.params?.threadId;
        const total = usage?.total;
        if (context.currentNativeTurnId && nativeTurnId && String(nativeTurnId) !== String(context.currentNativeTurnId)) {
          context.onTelemetry?.(telemetryObservation({
            source: 'codex.thread_token_usage', scope: 'turn', aggregation: 'delta', nativeTurnId,
            requestId: 'restored-old-turn',
            anomalies: [{ code: 'overlapping_sources', fields: ['inputTokensTotal', 'outputTokens', 'totalTokens'], detail: '恢复会话收到旧回合累计通知；已路由到原回合且未覆盖其既有回合用量', observedAt: new Date().toISOString(), raw: { nativeTurnId, currentNativeTurnId: context.currentNativeTurnId } }],
            attempt: { id: String(nativeTurnId), state: 'unknown' },
          }));
        } else if (total) {
          const prior = usageBaselines.get(threadId);
          const turnKey = `${threadId}:${nativeTurnId}`;
          if (prior !== undefined) {
            if (!turnBaselines.has(turnKey)) turnBaselines.set(turnKey, prior);
            const baseline = turnBaselines.get(turnKey);
            if (baseline !== null) {
              const delta = {
                inputTokensTotal: total.inputTokens - baseline.inputTokens,
                cacheReadTokens: total.cachedInputTokens - baseline.cachedInputTokens,
                cacheWriteTokens: total.cacheWriteInputTokens - baseline.cacheWriteInputTokens,
                outputTokens: total.outputTokens - baseline.outputTokens,
                totalTokens: total.totalTokens - baseline.totalTokens,
              };
              const negative = Object.values(delta).some(value => Number.isFinite(value) && value < 0);
              if (negative) {
                context.onTelemetry?.(telemetryObservation({
                  source: 'codex.thread_token_usage', scope: 'turn', aggregation: 'delta', nativeTurnId,
                  anomalies: [{ code: 'count_regression', fields: Object.keys(delta), detail: 'Codex 累计计数回退，未生成回合用量', observedAt: new Date().toISOString(), raw: { baseline, total } }],
                  attempt: { id: String(nativeTurnId ?? threadId), state: 'unknown' },
                }));
              } else if (!emittedTurns.has(turnKey) || Object.values(delta).some(value => value !== 0)) {
                context.onTelemetry?.(telemetryObservation({
                  source: 'codex.thread_token_usage', scope: 'turn', aggregation: 'delta', nativeTurnId,
                  usage: {
                    ...delta,
                    uncachedInputTokens: delta.inputTokensTotal - delta.cacheReadTokens - delta.cacheWriteTokens,
                  },
                  quality: { uncachedInputTokens: 'derived' },
                  formula: { uncachedInputTokens: 'inputTokensTotal - cacheReadTokens - cacheWriteTokens' },
                  completeness: {
                    inputTokensTotal: 'complete', uncachedInputTokens: 'complete', cacheReadTokens: 'complete',
                    cacheWriteTokens: 'complete', outputTokens: 'complete', totalTokens: 'complete',
                  },
                  attempt: { id: String(nativeTurnId ?? threadId), state: 'succeeded' },
                }));
                emittedTurns.add(turnKey);
              }
            }
            usageBaselines.set(threadId, {
              inputTokens: total.inputTokens,
              cachedInputTokens: total.cachedInputTokens,
              cacheWriteInputTokens: total.cacheWriteInputTokens,
              outputTokens: total.outputTokens,
              totalTokens: total.totalTokens,
            });
          }
        }
        if (usage && (usage.last || usage.modelContextWindow)) {
          context.onTelemetry?.(telemetryObservation({
            source: 'codex.token_usage', scope: 'request', aggregation: 'snapshot', nativeTurnId,
            context: {
              lastRequestInputTokens: usage.last?.inputTokens,
              contextWindowTokens: usage.modelContextWindow,
              model: context.telemetryModel ?? null,
            },
            completeness: { lastRequestInputTokens: 'complete', contextWindowTokens: 'complete' },
          }));
        }
      }
      if (row.method === 'turn/completed') {
        const turn = row.params?.turn;
        if (turn) {
          context.onTelemetry?.(telemetryObservation({
            source: 'codex.turn_completed', scope: 'turn', aggregation: 'delta', nativeTurnId: turn.id,
            timing: { hostTurnWallMs: turn.durationMs },
            completeness: { hostTurnWallMs: Number.isFinite(turn.durationMs) ? 'complete' : 'unknown' },
            attempt: { id: String(turn.id), state: turn.status === 'completed' ? 'succeeded' : 'failed' },
          }));
        }
      }
    }
    if ('id' in row && row.method) {
      if (row.method !== 'item/tool/call' || !context) return send({ id: row.id, error: { code: -32601, message: 'Unowned or unsupported request' } });
      const name = row.params.tool;
      if (!name.startsWith('agent_team_')) return send({ id: row.id, error: { code: -32601, message: 'Unowned tool' } });
      try { const value = await context.onTool(name.slice(11), row.params.arguments, { nativeCallId: row.params.callId }); send({ id: row.id, result: { contentItems: [{ type: 'inputText', text: JSON.stringify(value) }], success: true } }); }
      catch (error) { send({ id: row.id, result: { contentItems: [{ type: 'inputText', text: error.message }], success: false } }); }
    }
    if (row.method === 'item/started' && row.params.item?.type === 'collabAgentToolCall' && context) {
      const turnId = row.params.turnId;
      const error = new Error('Codex 原生子 Agent/协同工具不属于团队回合，已请求中断；请只结束当前回合，由框架投递下一条消息');
      context.violation ??= error;
      const waiter = waits.get(turnId);
      if (waiter) { clearTimeout(waiter.timer); waits.delete(turnId); waiter.reject(error); }
      request('turn/interrupt', { threadId: row.params.threadId, turnId }, 10000).catch(() => {});
    }
    if (row.method === 'item/completed' && row.params.item?.type === 'agentMessage' && context) context.text = row.params.item.text ?? '';
    if (row.method === 'turn/completed') {
      const turn = row.params.turn;
      const waiter = waits.get(turn.id);
      if (waiter) { clearTimeout(waiter.timer); waits.delete(turn.id); waiter.resolve(turn); }
      else ended.set(turn.id, turn);
    }
  }
  async function ready() {
    if (init) return init;
    init = (async () => {
      child = spawn(command, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
      child.on('error', fail);
      child.on('exit', (code, signal) => fail(new Error(`Codex app-server 退出 (${code ?? signal})：${stderr}`)));
      createInterface({ input: child.stdout }).on('line', line => {
        try { const row = JSON.parse(line); receive(row).catch(error => fail(error)); }
        catch { /* Non-protocol stdout is ignored; protocol requests still time out honestly. */ }
      });
      await request('initialize', { clientInfo: { name: 'agent-team', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      send({ method: 'initialized' });
      const configuration = await request('config/read', { includeLayers: false });
      serverNames = Object.keys(configuration.config?.mcp_servers ?? {});
    })();
    return init;
  }
  return {
    sessionKey({ policy }) { return policy.domain ?? (policy.mode === 'communication' ? 'communication' : 'project'); },
    async listModels() {
      await ready();
      const models = [];
      let cursor = null;
      do {
        const page = await request('model/list', { cursor, includeHidden: false, limit: 100 });
        models.push(...(page.data ?? []).map(model => ({
          id: model.id ?? model.model,
          label: model.displayName ?? model.id ?? model.model,
          description: model.description,
          inputModalities: model.inputModalities,
          reasoningEfforts: (model.supportedReasoningEfforts ?? []).map(effort => ({
            id: effort.reasoningEffort,
            label: effort.reasoningEffort,
            description: effort.description,
          })),
          defaultReasoningEffort: model.defaultReasoningEffort,
          isDefault: model.isDefault === true,
        })));
        cursor = page.nextCursor ?? null;
      } while (cursor);
      const preferred = models.find(model => model.isDefault) ?? models[0];
      return modelCatalog({ host: 'codex', source: 'codex.model/list', models, defaultModel: preferred?.id ?? null });
    },
    supportsPolicy({ policy }) {
      return policy.mode === 'communication' || policy.allowShell
        ? { supported: true }
        : { supported: false, reason: '当前 Codex 项目模式没有独立文件编辑工具，需要契约允许沙箱命令' };
    },
    telemetryCapabilities: telemetryCapabilitiesFor('codex'),
    async run(context) {
      await ready();
      const { endpoint, prompt, instructions, onSession, onAccepted, signal } = context;
      const selectedModel = context.modelSelection?.model ?? model;
      const selectedEffort = context.modelSelection?.reasoning_effort ?? reasoningEffort;
      if (signal.aborted) throw new Error('回合已中断');
      const policy = executionPolicy(context);
      if (policy.mode !== 'communication' && !policy.allowShell) throw new Error('Codex项目操作需要契约明确允许沙箱命令；请调整安排或由用户批准契约变更');
      const config = { ...codexPolicyConfig(policy, serverNames), ...(selectedEffort ? { model_reasoning_effort: selectedEffort } : {}) };
      const signature = JSON.stringify({ config, tools: context.tools.map(t => t.name) });
      if (endpoint.session && context.previousPolicy?.signature !== signature) throw new Error('Codex会话工具配置已变更或尚未验证；请由用户reset-session后重新建立，不会静默切换会话');
      const options = {
        cwd: context.workspace, approvalPolicy: 'never', sandbox: policy.mode === 'workspace-write' ? 'workspace-write' : 'read-only', developerInstructions: instructions,
        ...(selectedModel ? { model: selectedModel } : {}),
        config,
      };
      if (selectedModel || selectedEffort) context.onModel({ phase: 'requested', model: selectedModel ?? null, reasoningEffort: selectedEffort ?? null, source: context.modelSelection ? 'member.selection' : 'adapter.config' });
      const result = endpoint.session
        ? await request('thread/resume', { threadId: endpoint.session, ...options })
        : await request('thread/start', { ...options, dynamicTools: context.tools.map(tool => ({ type: 'function', name: `agent_team_${tool.name}`, description: tool.description, inputSchema: tool.inputSchema })) });
      const thread = result.thread.id;
      context.onPolicy?.({ ...policyObservation('codex', policy, { config, turnSandbox: policy.mode === 'workspace-write' ? 'workspaceWrite' : 'readOnly', tools: context.tools.map(t => t.name) }), signature });
      context.onModel({
        phase: 'session', model: result.model, provider: result.modelProvider, reasoningEffort: result.reasoningEffort,
        source: endpoint.session ? 'codex.thread_resume' : 'codex.thread_start',
      });
      if (result.model) {
        context.onSelection?.({
          model: result.model,
          reasoning_effort: result.reasoningEffort ?? null,
        });
      }
      onSession(thread);
      const live = { ...context, text: '', telemetryModel: result.model ? { provider: result.modelProvider ?? null, model: result.model, source: endpoint.session ? 'codex.thread_resume' : 'codex.thread_start', observedAt: new Date().toISOString() } : null };
      if (!usageBaselines.has(thread)) usageBaselines.set(thread, endpoint.session ? null : { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, totalTokens: 0 });
      active.set(thread, live);
      let turn;
      const interrupt = () => { if (turn) request('turn/interrupt', { threadId: thread, turnId: turn.id }, 10000).catch(() => {}); };
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        if (signal.aborted) throw new Error('回合已中断');
        turn = (await request('turn/start', { threadId: thread, input: [{ type: 'text', text: prompt }], approvalPolicy: 'never', sandboxPolicy: policy.mode === 'workspace-write'
          ? { type: 'workspaceWrite', writableRoots: [context.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false } })).turn;
        context.onNativeTurn(turn.id);
        live.currentNativeTurnId = turn.id;
        onAccepted();
        if (signal.aborted) interrupt();
        if (live.violation) throw live.violation;
        const complete = ended.get(turn.id) ?? await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waits.delete(turn.id); interrupt(); reject(Object.assign(new Error('Codex 回合超过 15 分钟，已请求中断，停止结果待核实'), { runtimeUnknown: true })); }, 900000);
          waits.set(turn.id, { resolve, reject, timer });
        });
        ended.delete(turn.id);
        if (complete.status !== 'completed') throw new Error(complete.error?.message ?? `Codex 回合 ${complete.status}`);
        return live.text;
      } finally { signal.removeEventListener('abort', interrupt); active.delete(thread); }
    },
    async close() {
      const process = child;
      if (!process) return;
      process.kill('SIGTERM');
      await new Promise(resolve => { const timer = setTimeout(() => { process.kill('SIGKILL'); resolve(); }, 2000); process.once('exit', () => { clearTimeout(timer); resolve(); }); });
    },
  };
}
