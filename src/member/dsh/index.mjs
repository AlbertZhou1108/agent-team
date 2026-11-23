import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliLifecycle } from '../../host-runtime/lifecycle.mjs';
import { connectionProbe, exchange } from '../../host-runtime/probe.mjs';
import { writeMcpFiles, runJsonProcess } from '../../host-runtime/process.mjs';
import { executionPolicy, policyObservation, sandboxMode, dshMcpToolPrefix, attachmentManifest, panelAttachmentsAllowed } from '../../hosts/policies.mjs';
import { probeBrowserMcpServers, normalizeBrowserProbeResult, BROWSER_MCP_UNAVAILABLE_REASON } from '../../hosts/browser-mcp-probe.mjs';
import { modelCatalog } from '../../hosts/catalog.mjs';
import { dshProcessEnv } from './credentials.mjs';
import { telemetryObservation } from '../../observation.mjs';
import { capability, capabilities, executionConditions, tokenConditions } from '../../capability-contract.mjs';
import { memberExecutionCapabilities, browserToolCapability } from '../../hosts/execution.mjs';

export const DSH_TRAITS = Object.freeze({});

export async function runDshCatalogProbe(command, directory, { signal, env } = {}) {
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
    { insert: [{ id: 'agent-team-model-catalog', name: fileURLToPath(new URL('./model-catalog.mjs', import.meta.url)) }] },
  ]), { mode: 0o600 });
  try {
    return await exchange(command, ['--profile', 'headless', '--patch', patchPath], {
      cwd: probeDirectory, signal, waitForExit: true, env: env ?? dshProcessEnv(),
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

export function createDshHost({ directory, socketPath, command = 'dsh', model, browserProbe }) {
  if (model) throw new Error('DSH 模型由其 headless profile 设置；本版本不伪造未验证的模型参数');
  const lifecycle = createCliLifecycle('dsh', command, value => { command = value; });
  // DSH 的受控启动会用 headless profile，用户 patch 层里声明的 MCP 会随启动继承；
  // 只读探测这些声明，命中白名单才由 dsh/policy.mjs 放行对应工具前缀。
  const inspectBrowserMcp = () => {
    try {
      const result = browserProbe
        ? browserProbe({ home: homedir(), env: process.env })
        : probeBrowserMcpServers({ host: 'dsh', home: homedir(), env: process.env });
      return normalizeBrowserProbeResult(result);
    } catch (error) {
      return { servers: [], reason: `${BROWSER_MCP_UNAVAILABLE_REASON}（探测异常：${error?.message ?? 'unknown'}）` };
    }
  };
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
    executionCapabilities({ mode, allowShell, allowBrowser }) {
      const report = memberExecutionCapabilities(DSH_TRAITS, { mode, allowShell });
      // DSH 无原生浏览器开关：只有 headless profile 用户 patch 里探测到真实可用的浏览器 MCP，
      // 且本轮启动会继承该配置并由 agent-team-policy 放行其工具时才点亮；否则如实 false。
      const browser = allowBrowser === true && report.effectivePolicy !== 'communication'
        ? inspectBrowserMcp()
        : { servers: [], reason: null };
      return {
        ...report,
        ...browserToolCapability({
          effectivePolicy: report.effectivePolicy,
          requested: allowBrowser === true,
          supported: browser.servers.length > 0,
          reason: browser.servers.length ? null : browser.reason ?? BROWSER_MCP_UNAVAILABLE_REASON,
        }),
      };
    },
    supportsPanelAccess({ access }) {
      return ['read-only', 'workspace-write', 'full-access'].includes(access)
        ? { supported: true }
        : { supported: false, reason: '未知私人访问级别' };
    },
    async run(context) {
      const { endpoint, prompt, instructions, onSession, onAccepted } = context;
      const policy = executionPolicy(context);
      // 浏览器 MCP 不克隆进 patch（同 serverName 重复注册会让 dsh 启动失败）；
      // headless profile 用户 patch 会随启动继承，因此只把探测结果交给 policy 放行工具前缀。
      const browserServers = policy.allowBrowser ? inspectBrowserMcp().servers : [];
      const files = writeMcpFiles(directory, socketPath, endpoint, context.turnId, {
        ...policy,
        access: context.policy?.access ?? null,
        workspace: context.workspace,
        tools: context.tools.map(t => `mcp__agent_team__${t.name}`),
        browserServers: browserServers
          .map(server => ({ name: server.name, toolPrefix: dshMcpToolPrefix(server.name) }))
          .filter(server => server.toolPrefix),
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
      // 模型路由要跟同一次请求的压力采样对齐；selection 可能晚于 projection 到达。
      const selection = context.modelSelection;
      let observedModel = selection?.model
        ? { provider: selection.model_provider ?? null, model: selection.model }
        : null;
      let pendingPressure = null;
      const emitContextPressure = (value, model) => context.onTelemetry?.(telemetryObservation({
        source: 'dsh.context_pressure', scope: 'request', aggregation: 'snapshot',
        context: {
          lastRequestInputTokens: value.pressureTokens,
          contextWindowTokens: value.contextWindow,
          ...(model ? {
            model: {
              provider: model.provider ?? null,
              model: model.model,
              source: 'dsh.context_pressure',
              observedAt: new Date().toISOString(),
            },
          } : {}),
        },
        completeness: {
          lastRequestInputTokens: value.pressureTokens != null ? 'complete' : 'unknown',
          contextWindowTokens: value.contextWindow != null ? 'complete' : 'unknown',
        },
        contextSource: {
          lastRequestInputTokens: 'dsh.context_pressure',
          contextWindowTokens: 'dsh.context_pressure',
        },
      }));
      await runJsonProcess(command, args, { ...context, env: dshProcessEnv(), onRow(row) {
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
            if (observedModel) emitContextPressure(row.value, observedModel);
            else pendingPressure = row.value;
          }
          return;
        }
        if (row.type === 'framework.model.selection') {
          if (row.model) {
            observedModel = { provider: row.provider ?? null, model: row.model };
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
            if (pendingPressure) {
              emitContextPressure(pendingPressure, observedModel);
              pendingPressure = null;
            }
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
      // 没有 selection 时仍保留压力观测；只是模型路由缺失，由批次层标记 scope_mismatch。
      if (pendingPressure) {
        emitContextPressure(pendingPressure, null);
        pendingPressure = null;
      }
      if (text === undefined || end !== 'completed') throw new Error('DSH 未完成回合，输入接受边界尚无法确认');
      onAccepted();
      return text;
    },
  };
}
