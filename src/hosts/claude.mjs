import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCliLifecycle } from './lifecycle.mjs';
import { connectionProbe, probeClaude, initializeClaude } from './probe.mjs';
import { writeMcpFiles, runJsonProcess } from './process.mjs';
import { executionPolicy, claudeExecutionConfig, policyObservation, attachmentManifest, panelAttachmentsAllowed } from './policies.mjs';
import { modelCatalog } from './catalog.mjs';
import { telemetryObservation } from '../observation.mjs';
import { capability, capabilities, executionConditions, tokenConditions } from '../capability-contract.mjs';

const efforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function claudeSessionFile(sessionId, configDirectory) {
  const projects = join(configDirectory, 'projects');
  if (!existsSync(projects)) return null;
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projects, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function readClaudeSessionMetadata(sessionId, configDirectory = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')) {
  const file = claudeSessionFile(sessionId, configDirectory);
  if (!file) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      const row = JSON.parse(line);
      if (row.type !== 'assistant') return [];
      return [{ model: row.message?.model ?? null, reasoningEffort: row.effort ?? null }];
    } catch { return []; }
  });
}
/** claude 的遥测能力声明:原生事件里的桶与质量语义由适配器自己声明。 */
export function claudeCapabilities() {
    const claudeInputs = ['result.usage.input_tokens', 'result.usage.cache_read_input_tokens', 'result.usage.cache_creation_input_tokens'];
    return capabilities('claude', {
      inputTokensTotal: capability('derived', 'claude.result_usage', claudeInputs, [...tokenConditions, 'inputTokensTotal = input_tokens + cache_read_input_tokens + cache_creation_input_tokens', 'assistant 重复事件不逐条累加']),
      uncachedInputTokens: capability('direct', 'claude.result_usage', ['result.usage.input_tokens'], [...tokenConditions, 'assistant 重复事件不逐条累加']),
      cacheReadTokens: capability('direct', 'claude.result_usage', ['result.usage.cache_read_input_tokens'], tokenConditions),
      cacheWriteTokens: capability('direct', 'claude.result_usage', ['result.usage.cache_creation_input_tokens'], tokenConditions),
      outputTokens: capability('direct', 'claude.result_usage', ['result.usage.output_tokens'], ['以 result 最终输出为准，不用 assistant 尚未结算的输出代替']),
      totalTokens: capability('derived', 'claude.result_usage', ['完整输入', 'result 最终输出'], ['输入与输出同一运行范围']),
      cacheReadRatio: capability('derived', 'query.aggregate', ['cacheReadTokens', 'inputTokensTotal'], ['同一完整样本集合', '输入为 0 时不生成比例']),
      executionWallMs: capability('derived', 'framework.measured', ['run start/settle'], executionConditions),
      hostTurnWallMs: capability('direct', 'claude.result_usage', ['result.duration_ms'], ['宿主成功报告运行汇总']),
      lastRequestInputTokens: capability('derived', 'claude.assistant_message_usage', ['assistant.message.usage 输入三桶'], ['lastRequestInputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens', '按宿主消息身份去重并更新最终值']),
      contextWindowTokens: capability('direct', 'claude.model_usage', ['result.modelUsage[model].contextWindow'], ['模型键与最近请求模型匹配']),
      lastRequestInputRatio: capability('derived', 'query.aggregate', ['lastRequestInputTokens', 'contextWindowTokens'], ['模型路由匹配且窗口大于 0']),
    });
}

export function createClaudeHost({
  directory, socketPath, command = 'claude', model, reasoningEffort,
  permissionMode: _permissionMode = 'dontAsk', allowEdits: _allowEdits = false, configDirectory,
}) {
  if (reasoningEffort && !efforts.has(reasoningEffort)) throw new Error(`Claude 思考强度无效: ${reasoningEffort}`);
  configDirectory ??= process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const verified = new Map();
  const lifecycle = createCliLifecycle('claude', command, value => { command = value; });
  return {
    ...lifecycle,
    ...connectionProbe(lifecycle, signal => probeClaude(command, { configDirectory, signal })),
    async listModels(options = {}) {
      const initialized = await initializeClaude(command, { configDirectory, ...options });
      if (!Array.isArray(initialized.models) || !initialized.models.length) throw new Error('Claude 未提供模型目录，请检查宿主版本与配置');
      const models = initialized.models.map(item => ({
        id: item.value,
        label: item.displayName ?? item.value,
        description: item.description,
        reasoningEfforts: item.supportedEffortLevels ?? [],
        ...(reasoningEffort ? { defaultReasoningEffort: reasoningEffort } : {}),
        isDefault: item.value === (model ?? 'default'),
      }));
      return modelCatalog({ host: 'claude', source: 'claude.control.initialize', models,
        defaultModel: models.find(item => item.isDefault)?.id ?? null });
    },
    telemetryCapabilities: claudeCapabilities(),
    executionCapabilities({ mode, allowShell }) {
      if (mode === 'communication') {
        return { effectivePolicy: 'communication', capabilities: [], reason: '仅允许团队通信' };
      }
      if (mode === 'read-only') {
        return { effectivePolicy: 'read-only', capabilities: ['file.read'], reason: '群策略只允许读取' };
      }
      if (process.platform === 'win32') {
        return {
          effectivePolicy: 'read-only',
          capabilities: ['file.read'],
          reason: 'Claude Code 在当前 Windows 会话无法保证工作区写边界',
        };
      }
      return {
        effectivePolicy: 'workspace-write',
        capabilities: ['file.read', 'file.write', 'filesystem.boundary', ...(allowShell ? ['shell.exec'] : [])],
        reason: allowShell ? null : '未启用 shell；仍允许受限文件编辑',
      };
    },
    supportsPanelAccess({ access }) {
      return ['read-only', 'workspace-write', 'full-access'].includes(access)
        ? { supported: true }
        : { supported: false, reason: '未知私人访问级别' };
    },
    async run(context) {
      const { endpoint, prompt, instructions, onSession, onAccepted } = context;
      const selectedModel = context.modelSelection?.model ?? model;
      const selectedEffort = context.modelSelection?.reasoning_effort ?? reasoningEffort;
      const policy = executionPolicy(context);
      const files = writeMcpFiles(directory, socketPath, endpoint, context.turnId);
      const { builtins, allowed, sandbox } = claudeExecutionConfig(policy, context.tools, context.workspace);
      const settings = { disableAllHooks: true };
      if (sandbox) settings.sandbox = sandbox;
      if (selectedEffort) settings.env = { CLAUDE_CODE_EFFORT_LEVEL: selectedEffort };
      const args = ['-p', '--setting-sources', 'user', '--settings', JSON.stringify(settings), '--strict-mcp-config', '--mcp-config', files.claude, '--tools', builtins.join(','), '--allowedTools', allowed.join(','), '--permission-mode', 'dontAsk', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--append-system-prompt', instructions];
      if (endpoint.session) args.push('--resume', endpoint.session);
      if (selectedModel) args.push('--model', selectedModel);
      if (selectedEffort) args.push('--effort', selectedEffort);
      // TXT/PNG 均走已验证的 Read 工具;清单只进宿主输入,不回写用户正文。
      if ((context.attachments ?? []).length && !panelAttachmentsAllowed(context.policy)) {
        throw new Error('当前会话模式不支持附件输入');
      }
      const attachmentManifestText = attachmentManifest(context.attachments);
      args.push('--', attachmentManifestText
        ? `${prompt}\n\n[附件文件清单 - 请用 Read 工具读取以下文件]\n${attachmentManifestText}`
        : prompt);
      context.onPolicy?.(policyObservation('claude', policy, { builtins, allowed, mode: 'dontAsk', sandbox: settings.sandbox ?? null, panelAccess: context.policy?.access ?? null }));
      let result, sessionId = endpoint.session;
      let assistantModel = null;
      let selectionModel = selectedModel ?? null;
      let _lastAssistantUsage = null;
      let resultEmitted = false;
      const seenAssistant = new Set();
      const toolBlocks = new Map();
      if (selectedModel || selectedEffort) context.onModel({ phase: 'requested', model: selectedModel ?? null, reasoningEffort: selectedEffort ?? null, source: context.modelSelection ? 'member.selection' : 'adapter.config' });
      await runJsonProcess(command, args, { ...context, onRow(row) {
        if (row.session_id && row.session_id !== sessionId) { sessionId = row.session_id; onSession(sessionId); }
        if (row.type === 'stream_event'
          && row.event?.type === 'content_block_delta'
          && row.event?.delta?.type === 'text_delta'
          && typeof row.event.delta.text === 'string') {
          context.onTextDelta?.(row.event.delta.text, {
            requestId: row.uuid ?? null,
            blockIndex: row.event.index ?? null,
          });
        }
        if (row.type === 'stream_event'
          && row.event?.type === 'content_block_delta'
          && row.event?.delta?.type === 'thinking_delta'
          && typeof row.event.delta.thinking === 'string') {
          context.onReasoningDelta?.(row.event.delta.thinking, {
            requestId: row.uuid ?? null,
            blockIndex: row.event.index ?? null,
          });
        }
        if (row.type === 'stream_event'
          && row.event?.type === 'content_block_start'
          && row.event?.content_block?.type === 'tool_use') {
          const index = row.event.index;
          const block = {
            id: row.event.content_block.id,
            name: row.event.content_block.name,
          };
          toolBlocks.set(index, block);
          context.onToolCallDelta?.({
            callId: block.id,
            name: block.name,
            index,
            argumentsDelta: '',
          });
        }
        if (row.type === 'stream_event'
          && row.event?.type === 'content_block_delta'
          && row.event?.delta?.type === 'input_json_delta') {
          const block = toolBlocks.get(row.event.index);
          if (block) {
            context.onToolCallDelta?.({
              callId: block.id,
              name: block.name,
              index: row.event.index,
              argumentsDelta: row.event.delta.partial_json ?? '',
            });
          }
        }
        if (row.type === 'system' && row.subtype === 'init' && row.model) {
          selectionModel = row.model;
          context.onModel({ phase: 'session', model: row.model, provider: 'claude', source: 'claude.system.init' });
          context.onSelection?.({ model: row.model, reasoning_effort: selectedEffort ?? null });
        }
        if (row.type === 'assistant' && row.message?.model && row.message.model !== assistantModel) {
          assistantModel = row.message.model;
          context.onModel({ phase: 'assistant', model: assistantModel, provider: 'claude', source: 'claude.assistant.message' });
        }
        if (row.type === 'assistant' && row.message?.usage) {
          const usage = row.message.usage;
          const messageId = row.message.id ?? row.uuid ?? row.message.uuid ?? `${row.message.model ?? 'unknown'}:${usage.input_tokens ?? '?'}:${usage.cache_read_input_tokens ?? '?'}:${usage.cache_creation_input_tokens ?? '?'}`;
          _lastAssistantUsage = usage;
          if (!seenAssistant.has(messageId)) {
            seenAssistant.add(messageId);
            const inputBuckets = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
            const inputComplete = inputBuckets.every(value => Number.isFinite(value));
            const inputTotal = inputBuckets.some(value => Number.isFinite(value))
              ? inputBuckets.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
              : undefined;
            context.onTelemetry?.(telemetryObservation({
              source: 'claude.assistant_message_usage', scope: 'request', aggregation: 'snapshot', requestId: messageId,
              usage: {
                ...(inputTotal !== undefined ? { inputTokensTotal: inputTotal } : {}),
                ...(Number.isFinite(usage.input_tokens) ? { uncachedInputTokens: usage.input_tokens } : {}),
                ...(Number.isFinite(usage.cache_read_input_tokens) ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
                ...(Number.isFinite(usage.cache_creation_input_tokens) ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
                ...(Number.isFinite(usage.output_tokens) ? { outputTokens: usage.output_tokens } : {}),
              },
              quality: { inputTokensTotal: 'derived', uncachedInputTokens: 'host_reported', lastRequestInputTokens: 'derived' },
              formula: {
                inputTokensTotal: 'input_tokens + cache_read_input_tokens + cache_creation_input_tokens',
                lastRequestInputTokens: 'input_tokens + cache_read_input_tokens + cache_creation_input_tokens',
              },
              completeness: {
                inputTokensTotal: inputComplete ? 'complete' : inputTotal !== undefined ? 'partial' : 'unknown',
                uncachedInputTokens: Number.isFinite(usage.input_tokens) ? 'complete' : 'unknown',
                cacheReadTokens: Number.isFinite(usage.cache_read_input_tokens) ? 'complete' : 'unknown',
                cacheWriteTokens: Number.isFinite(usage.cache_creation_input_tokens) ? 'complete' : 'unknown',
                outputTokens: Number.isFinite(usage.output_tokens) && usage.output_tokens > 0 ? 'complete' : 'partial',
              },
              context: inputTotal !== undefined ? { lastRequestInputTokens: inputTotal } : {},
              contextSource: { lastRequestInputTokens: 'claude.assistant_message_usage' },
            }));
          }
        }
        if (row.type === 'result') {
          result = row;
          if (!resultEmitted) {
            resultEmitted = true;
            const usage = row.usage ?? {};
            const inputBuckets = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
            const inputComplete = inputBuckets.every(value => Number.isFinite(value));
            const inputTotal = inputBuckets.some(value => Number.isFinite(value))
              ? inputBuckets.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
              : undefined;
            const outputTokens = Number.isFinite(usage.output_tokens) ? usage.output_tokens : undefined;
            const modelUsages = row.modelUsage ?? {};
            const modelKey = Object.keys(modelUsages).length === 1 ? Object.keys(modelUsages)[0] : (assistantModel && modelUsages[assistantModel] ? assistantModel : Object.keys(modelUsages)[0]);
            const modelInfo = modelKey ? modelUsages[modelKey] : null;
            context.onTelemetry?.(telemetryObservation({
              source: 'claude.result_usage', scope: 'turn', aggregation: 'delta', requestId: row.uuid ?? null,
              usage: {
                ...(inputTotal !== undefined ? { inputTokensTotal: inputTotal } : {}),
                ...(Number.isFinite(usage.input_tokens) ? { uncachedInputTokens: usage.input_tokens } : {}),
                ...(Number.isFinite(usage.cache_read_input_tokens) ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
                ...(Number.isFinite(usage.cache_creation_input_tokens) ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
                ...(inputTotal !== undefined && outputTokens !== undefined ? { totalTokens: inputTotal + outputTokens } : {}),
              },
              quality: {
                totalTokens: 'derived',
                inputTokensTotal: 'derived',
                uncachedInputTokens: 'host_reported',
                cacheReadTokens: 'host_reported',
                cacheWriteTokens: 'host_reported',
                outputTokens: 'host_reported',
                lastRequestInputTokens: 'derived',
              },
              formula: {
                totalTokens: 'inputTokensTotal + outputTokens',
                inputTokensTotal: 'input_tokens + cache_read_input_tokens + cache_creation_input_tokens',
                lastRequestInputTokens: 'input_tokens + cache_read_input_tokens + cache_creation_input_tokens',
              },
              completeness: {
                inputTokensTotal: inputComplete ? 'complete' : inputTotal !== undefined ? 'partial' : 'unknown',
                uncachedInputTokens: Number.isFinite(usage.input_tokens) ? 'complete' : 'unknown',
                cacheReadTokens: Number.isFinite(usage.cache_read_input_tokens) ? 'complete' : 'unknown',
                cacheWriteTokens: Number.isFinite(usage.cache_creation_input_tokens) ? 'complete' : 'unknown',
                outputTokens: outputTokens !== undefined ? 'complete' : 'unknown',
                totalTokens: inputTotal !== undefined && outputTokens !== undefined ? (inputComplete ? 'complete' : 'partial') : 'unknown',
                hostTurnWallMs: Number.isFinite(row.duration_ms) ? 'complete' : 'unknown',
              },
              timing: { hostTurnWallMs: Number.isFinite(row.duration_ms) ? row.duration_ms : undefined },
              context: modelInfo ? {
                lastRequestInputTokens: inputTotal,
                contextWindowTokens: modelInfo.contextWindow,
                model: modelKey ? { provider: 'claude', model: modelKey, source: 'claude.result.modelUsage', observedAt: new Date().toISOString() } : null,
              } : undefined,
              contextSource: modelInfo ? {
                lastRequestInputTokens: 'claude.result_usage',
                contextWindowTokens: 'claude.model_usage',
              } : {},
              anomalies: row.is_error ? [{ code: 'anomaly', fields: ['outputTokens'], detail: 'Claude 运行报告 is_error；保留已报告部分用量', observedAt: new Date().toISOString(), raw: { is_error: row.is_error } }] : [],
              attempt: { id: String(row.uuid ?? sessionId ?? 'claude-run'), state: row.is_error ? 'failed' : 'succeeded' },
            }));
          }
        }
      } });
      if (!result || result.is_error) throw new Error(result?.result || 'Claude 未返回可确认的结果');
      if (result.modelUsage && Object.keys(result.modelUsage).length) {
        context.onModel({ phase: 'usage', models: Object.keys(result.modelUsage), provider: 'claude', source: 'claude.result.modelUsage' });
      }
      if (sessionId) {
        const latest = readClaudeSessionMetadata(sessionId, configDirectory).at(-1);
        const previous = verified.get(endpoint.id);
        if (latest && (latest.model !== previous?.model || latest.reasoningEffort !== previous?.reasoningEffort)) {
          context.onModel({
            phase: 'verified', model: latest.model, reasoningEffort: latest.reasoningEffort,
            provider: 'claude', source: 'claude.project_transcript',
          });
          if (selectionModel) context.onSelection?.({ model: selectionModel, reasoning_effort: latest.reasoningEffort ?? null });
          verified.set(endpoint.id, latest);
        }
      }
      // Print mode has no separately verified durable enqueue receipt: acknowledge conservatively.
      onAccepted();
      return result.result ?? '';
    },
  };
}
