import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliLifecycle } from './lifecycle.mjs';
import { connectionProbe, exchange } from './probe.mjs';
import { writeMcpFiles, runJsonProcess } from './process.mjs';
import { executionPolicy, policyObservation, sandboxMode, attachmentManifest, panelAttachmentsAllowed } from './policies.mjs';
import { modelCatalog } from './catalog.mjs';
import { telemetryObservation } from '../observation.mjs';
import { capability, capabilities, executionConditions, tokenConditions } from '../capability-contract.mjs';

export async function runDshCatalogProbe(command, directory, { signal } = {}) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const patchDirectory = join(directory, 'model-catalog');
  mkdirSync(patchDirectory, { recursive: true, mode: 0o700 });
  const probeDirectory = mkdtempSync(join(patchDirectory, 'probe-'));
  const patchPath = join(probeDirectory, 'dsh.patch.json');
  writeFileSync(patchPath, JSON.stringify([
    { id: 'headless-runner', disabled: true },
    { id: 'headless-startup', disabled: true },
    { id: 'session-persistence-jsonl', config: { root: join(probeDirectory, 'sessions') } },
    { id: 'storage-json', config: { root: join(probeDirectory, 'storage') } },
    { insert: [{ id: 'agent-team-model-catalog', name: fileURLToPath(new URL('./dsh-model-catalog.mjs', import.meta.url)) }] },
  ]), { mode: 0o600 });
  try {
    return await exchange(command, ['--profile', 'headless', '--patch', patchPath], {
      cwd: probeDirectory, signal, waitForExit: true,
      receive(line) {
        const prefix = 'AGENT_TEAM_DSH_MODEL_CATALOG ';
        if (!line.startsWith(prefix)) return;
        const result = JSON.parse(line.slice(prefix.length));
        if (!result.ok || !Array.isArray(result.providers)) throw new Error(result.failures?.map(item => item.error).join('; ') || 'DSH 没有可用模型');
        return result;
      },
    });
  } finally { rmSync(probeDirectory, { recursive: true, force: true }); }
}
/** dsh 的遥测能力声明:原生事件里的桶与质量语义由适配器自己声明。 */
export function dshCapabilities() {
    const dshTokens = ['assistant/message.usage.inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'];
    return capabilities('dsh', {
      inputTokensTotal: capability('derived', 'dsh.assistant_message_usage', dshTokens, [...tokenConditions, 'inputTokensTotal = usage.inputTokens + cacheReadTokens + cacheWriteTokens', '不与 session tokenUsage 投影相加']),
      uncachedInputTokens: capability('direct', 'dsh.assistant_message_usage', ['usage.inputTokens'], tokenConditions),
      cacheReadTokens: capability('direct', 'dsh.assistant_message_usage', ['usage.cacheReadTokens'], tokenConditions),
      cacheWriteTokens: capability('direct', 'dsh.assistant_message_usage', ['usage.cacheWriteTokens'], tokenConditions),
      outputTokens: capability('direct', 'dsh.assistant_message_usage', ['usage.outputTokens'], tokenConditions),
      totalTokens: capability('direct', 'dsh.assistant_message_usage', ['usage.totalTokens'], ['优先核对宿主 total', '不与 session 投影相加']),
      cacheReadRatio: capability('derived', 'query.aggregate', ['cacheReadTokens', 'inputTokensTotal'], ['同一完整样本集合', '输入为 0 时不生成比例']),
      executionWallMs: capability('derived', 'framework.measured', ['run start/settle'], executionConditions),
      hostTurnWallMs: capability('direct', 'dsh.turn_time', ['turn/end.time - turn/start.time'], ['插件提供原生回合起止时间']),
      lastRequestInputTokens: capability('direct', 'dsh.context_pressure', ['contextPressure.pressureTokens'], ['最近请求采样，不与 projectedTokens 混淆']),
      contextWindowTokens: capability('direct', 'dsh.context_pressure', ['contextPressure.contextWindow'], ['与压力采样同一模型路由']),
      lastRequestInputRatio: capability('derived', 'query.aggregate', ['lastRequestInputTokens', 'contextWindowTokens'], ['模型路由匹配且窗口大于 0']),
    });
}

export function createDshHost({ directory, socketPath, command = 'dsh', model }) {
  if (model) throw new Error('DSH 模型由其 headless profile 设置；本版本不伪造未验证的模型参数');
  const lifecycle = createCliLifecycle('dsh', command, value => { command = value; });
  return {
    ...lifecycle,
    ...connectionProbe(lifecycle, signal => runDshCatalogProbe(command, directory, { signal })),
    async listModels(options = {}) {
      const result = await runDshCatalogProbe(command, directory, options);
      const models = result.providers.flatMap(provider => provider.models ?? []);
      return modelCatalog({
        host: 'dsh',
        source: 'dsh.modelCatalog',
        models,
        defaultModel: models.some(item => item.key === result.defaultModel) ? result.defaultModel : null,
      });
    },
    telemetryCapabilities: dshCapabilities(),
    supportsPanelAccess({ access }) {
      return ['read-only', 'workspace-write', 'full-access'].includes(access)
        ? { supported: true }
        : { supported: false, reason: '未知私人访问级别' };
    },
    async run(context) {
      const { endpoint, prompt, instructions, onSession, onAccepted } = context;
      const policy = executionPolicy(context);
      const files = writeMcpFiles(directory, socketPath, endpoint, context.turnId, {
        ...policy,
        access: context.policy?.access ?? null,
        workspace: context.workspace,
        tools: context.tools.map(t => `mcp__agent_team__${t.name}`),
        modelSelection: context.modelSelection,
      });
      const args = ['headless', '--patch', files.dsh, '--json'];
      if (endpoint.session) args.push('--session-id', endpoint.session);
      // TXT/PNG 走 headless read/read_image;清单只进宿主输入,不回写用户正文。
      if ((context.attachments ?? []).length && !panelAttachmentsAllowed(context.policy)) {
        throw new Error('当前会话模式不支持附件输入');
      }
      const attachmentManifestText = attachmentManifest(context.attachments);
      const turnPrompt = attachmentManifestText
        ? `${prompt}\n\n[附件文件清单 - 请用 read/read_image 工具读取以下文件]\n${attachmentManifestText}`
        : prompt;
      args.push(`${instructions}\n\n当前输入：\n${turnPrompt}`);
      context.onPolicy?.(policyObservation('dsh', policy, { sessionPolicy: sandboxMode(policy.mode), agentScopedToolRestriction: true, approval: 'never' }));
      let text, end, streamedText = '';
      const turnStarts = new Map();
      const emittedTurnTiming = new Set();
      await runJsonProcess(command, args, { ...context, onRow(row) {
        const delta = row.type === 'framework.text.delta'
          ? row.text
          : row.type === 'assistant_delta'
          ? row.text ?? row.delta
          : row.type === 'message_delta' && row.role === 'assistant'
            ? row.text ?? row.delta
            : null;
        if (typeof delta === 'string' && delta) {
          streamedText += delta;
          context.onTextDelta?.(delta, {
            nativeTurnId: row.turn == null ? null : String(row.turn),
            step: row.step == null ? null : String(row.step),
          });
        }
        if (row.type === 'framework.reasoning.delta' && typeof row.text === 'string' && row.text) {
          context.onReasoningDelta?.(row.text, {
            nativeTurnId: row.turn == null ? null : String(row.turn),
            step: row.step == null ? null : String(row.step),
          });
        }
        if (row.type === 'framework.tool.delta') {
          context.onToolCallDelta?.({
            callId: row.callId,
            name: row.name,
            index: row.index,
            argumentsDelta: row.argumentsDelta ?? '',
          });
        }
        if (row.type === 'tool_call') {
          const input = typeof row.input === 'string'
            ? row.input
            : JSON.stringify(row.input ?? {});
          context.onToolCallDelta?.({
            callId: row.callId,
            name: row.tool,
            index: row.index,
            argumentsDelta: input,
            complete: true,
          });
        }
        if (row.type === 'framework.telemetry.event') {
          const turnRef = row.turn != null ? String(row.turn) : '';
          if (row.event === 'turn/start' && Number.isFinite(row.at)) turnStarts.set(turnRef, row.at);
          if (row.event === 'assistant/message' && row.usage) {
            const usage = row.usage;
            const inputBuckets = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
            const inputComplete = inputBuckets.every(value => Number.isFinite(value));
            const inputTotal = inputBuckets.some(value => Number.isFinite(value))
              ? inputBuckets.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
              : undefined;
            const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : undefined;
            const hostTotal = Number.isFinite(usage.totalTokens) ? usage.totalTokens : undefined;
            const totalTokens = hostTotal ?? (inputTotal !== undefined && outputTokens !== undefined ? inputTotal + outputTokens : undefined);
            const requestId = `${turnRef}:${row.step ?? ''}:${row.at ?? ''}`;
            context.onTelemetry?.(telemetryObservation({
              source: 'dsh.assistant_message_usage', scope: 'step', aggregation: 'delta',
              nativeTurnId: turnRef || null, stepId: row.step != null ? String(row.step) : null, requestId,
              usage: {
                ...(inputTotal !== undefined ? { inputTokensTotal: inputTotal } : {}),
                ...(Number.isFinite(usage.inputTokens) ? { uncachedInputTokens: usage.inputTokens } : {}),
                ...(Number.isFinite(usage.cacheReadTokens) ? { cacheReadTokens: usage.cacheReadTokens } : {}),
                ...(Number.isFinite(usage.cacheWriteTokens) ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
                ...(totalTokens !== undefined ? { totalTokens } : {}),
              },
              quality: {
                inputTokensTotal: 'derived',
                totalTokens: hostTotal !== undefined ? 'host_reported' : totalTokens !== undefined ? 'derived' : 'unknown',
              },
              formula: {
                inputTokensTotal: 'usage.inputTokens + cacheReadTokens + cacheWriteTokens',
                ...(hostTotal === undefined && totalTokens !== undefined ? { totalTokens: 'inputTokensTotal + outputTokens' } : {}),
              },
              completeness: {
                inputTokensTotal: inputComplete ? 'complete' : inputTotal !== undefined ? 'partial' : 'unknown',
                uncachedInputTokens: Number.isFinite(usage.inputTokens) ? 'complete' : 'unknown',
                cacheReadTokens: Number.isFinite(usage.cacheReadTokens) ? 'complete' : 'unknown',
                cacheWriteTokens: Number.isFinite(usage.cacheWriteTokens) ? 'complete' : 'unknown',
                outputTokens: outputTokens !== undefined ? 'complete' : 'unknown',
                totalTokens: totalTokens !== undefined ? (hostTotal !== undefined || inputComplete && outputTokens !== undefined ? 'complete' : 'partial') : 'unknown',
              },
              attempt: { id: `dsh:${turnRef}`, state: 'succeeded' },
            }));
          }
          if (row.event === 'turn/end' && !emittedTurnTiming.has(turnRef)) {
            emittedTurnTiming.add(turnRef);
            const started = turnStarts.get(turnRef);
            const wallMs = Number.isFinite(started) && Number.isFinite(row.at) ? row.at - started : null;
            context.onTelemetry?.(telemetryObservation({
              source: 'dsh.turn_time', scope: 'turn', aggregation: 'delta', nativeTurnId: turnRef || null,
              timing: { hostTurnWallMs: wallMs },
              completeness: { hostTurnWallMs: wallMs === null ? 'unknown' : 'complete' },
              anomalies: row.reason && row.reason !== 'completed'
                ? [{ code: 'anomaly', fields: ['hostTurnWallMs'], detail: `DSH 回合结束原因：${row.reason}`, observedAt: new Date().toISOString(), raw: { reason: row.reason } }]
                : [],
              attempt: { id: `dsh:${turnRef}`, state: row.reason === 'completed' ? 'succeeded' : 'failed' },
            }));
          }
          return;
        }
        if (row.type === 'framework.telemetry.projection') {
          if (row.key === 'contextPressure' && row.value && (row.value.pressureTokens != null || row.value.contextWindow != null)) {
            context.onTelemetry?.(telemetryObservation({
              source: 'dsh.context_pressure', scope: 'request', aggregation: 'snapshot',
              context: {
                lastRequestInputTokens: row.value.pressureTokens,
                contextWindowTokens: row.value.contextWindow,
              },
              completeness: {
                lastRequestInputTokens: row.value.pressureTokens != null ? 'complete' : 'unknown',
                contextWindowTokens: row.value.contextWindow != null ? 'complete' : 'unknown',
              },
              contextSource: {
                lastRequestInputTokens: 'dsh.context_pressure',
                contextWindowTokens: 'dsh.context_pressure',
              },
            }));
          }
          return;
        }
        if (row.type === 'framework.model.selection') {
          if (row.model) {
            context.onModel?.({
              phase: 'session',
              model: row.model,
              provider: row.provider ?? null,
              reasoningEffort: row.reasoningEffort ?? null,
              source: 'dsh.agent_request',
            });
            context.onSelection?.({
              model_provider: row.provider ?? null,
              model: row.model,
              reasoning_effort: row.reasoningEffort ?? null,
            });
          }
          return;
        }
        if (row.type === 'status' && row.phase === 'turn_start' && row.turn !== undefined) context.onNativeTurn(row.turn);
        if (row.type === 'session') onSession(row.sessionId);
        if (row.type === 'text') {
          if (typeof row.text === 'string' && row.text && !streamedText) {
            streamedText = row.text;
            context.onTextDelta?.(row.text, { committed: true });
          } else if (typeof row.text === 'string' && row.text.startsWith(streamedText) && row.text.length > streamedText.length) {
            const remainder = row.text.slice(streamedText.length);
            streamedText = row.text;
            context.onTextDelta?.(remainder, { committed: true });
          }
        }
        if (row.type === 'final') text = row.text;
        if (row.type === 'status' && row.phase === 'turn_end') end = row.reason?.kind;
        if (row.type === 'error') throw new Error(row.message ?? row.error ?? 'DSH 回合失败');
      } });
      if (text === undefined || end !== 'completed') throw new Error('DSH 未完成回合，输入接受边界尚无法确认');
      onAccepted();
      return text;
    },
  };
}
