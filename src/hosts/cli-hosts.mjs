import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { writeMcpFiles, runJsonProcess } from './process.mjs';
import { executionPolicy, claudeExecutionConfig, policyObservation, sandboxMode } from './policies.mjs';
import { modelCatalog } from './catalog.mjs';
import { telemetryCapabilitiesFor, telemetryObservation } from '../telemetry.mjs';

const efforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function claudeSessionFile(sessionId, configDirectory) {
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

function runClaudeSlashCommand(command, prompt, { directory, configDirectory }) {
  const settings = JSON.stringify({ disableAllHooks: true });
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', 'user', '--settings', settings, '--tools', '',
    '--permission-mode', 'dontAsk', '--no-session-persistence',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env: { ...process.env, ...(configDirectory ? { CLAUDE_CONFIG_DIR: configDirectory } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '', result, failure;
    const timer = setTimeout(() => {
      failure = new Error(`Claude 模型目录探测超时：${prompt}`);
      child.kill('SIGTERM');
    }, 20000);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const row = JSON.parse(line);
        if (row.type === 'result') result = row.result;
      } catch {
        // Claude may prepend non-protocol diagnostics; they are not model data.
      }
    });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`${command} 模型目录探测退出 (${code})：${stderr || '无诊断信息'}`));
      if (typeof result !== 'string') return reject(new Error(`Claude 未返回 ${prompt} 的模型信息`));
      resolve(result);
    });
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
  });
}

function parseClaudeModels(value) {
  const current = /Current model:\s*([^\s(]+)/.exec(value)?.[1] ?? null;
  const available = value.split('Available:')[1]
    ?.replace(/,\s*or a full model ID\.?\s*$/i, '')
    .trim();
  if (!available) throw new Error('Claude /model 未返回可用模型列表');
  return {
    current,
    models: [...new Set(available.split(',').map(item => item.trim()).filter(Boolean))],
  };
}

function parseClaudeEfforts(value) {
  const body = /Usage:\s*\/effort\s+<([^>]+)>/i.exec(value)?.[1];
  if (!body) throw new Error('Claude /effort 未返回思考强度列表');
  return [...new Set(body.split('|').map(item => item.trim()).filter(Boolean))];
}

function runDshCatalogProbe(command, directory) {
  const patchDirectory = join(directory, 'model-catalog');
  mkdirSync(patchDirectory, { recursive: true, mode: 0o700 });
  const patchPath = join(patchDirectory, 'dsh.patch.json');
  writeFileSync(patchPath, JSON.stringify([{
    insert: [{
      id: 'agent-team-model-catalog',
      name: fileURLToPath(new URL('./dsh-model-catalog.mjs', import.meta.url)),
    }],
  }]), { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['--profile', 'headless', '--patch', patchPath, 'catalog-probe'], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '', result, failure;
    const timer = setTimeout(() => {
      failure = new Error('DSH 模型目录探测超时');
      child.kill('SIGTERM');
    }, 20000);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
    createInterface({ input: child.stdout }).on('line', line => {
      const prefix = 'AGENT_TEAM_DSH_MODEL_CATALOG ';
      if (!line.startsWith(prefix)) return;
      try { result = JSON.parse(line.slice(prefix.length)); }
      catch (error) { failure = new Error(`DSH 模型目录返回无效 JSON：${error.message}`); }
    });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`${command} 模型目录探测退出 (${code})：${stderr || '无诊断信息'}`));
      if (!result) return reject(new Error(`DSH 未返回模型目录：${stderr || '无诊断信息'}`));
      if (!result.ok) return reject(new Error(result.failures?.map(item => item.error).filter(Boolean).join('; ') || 'DSH 没有可用模型'));
      resolve(result);
    });
  });
}

export function createClaudeHost({
  directory, socketPath, command = 'claude', model, reasoningEffort,
  permissionMode = 'dontAsk', allowEdits = false, configDirectory,
}) {
  if (reasoningEffort && !efforts.has(reasoningEffort)) throw new Error(`Claude 思考强度无效: ${reasoningEffort}`);
  configDirectory ??= process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const verified = new Map();
  return {
    async listModels() {
      const [modelValue, effortValue] = await Promise.all([
        runClaudeSlashCommand(command, '/model', { directory, configDirectory }),
        runClaudeSlashCommand(command, '/effort', { directory, configDirectory }),
      ]);
      const parsed = parseClaudeModels(modelValue);
      const reasoningEfforts = parseClaudeEfforts(effortValue);
      const modelIds = [...new Set([...(parsed.current ? [parsed.current] : []), ...parsed.models])];
      return modelCatalog({
        host: 'claude',
        source: 'claude-cli./model+/effort',
        defaultModel: parsed.current,
        reasoningEfforts,
        models: modelIds.map(id => ({ id, label: id, isDefault: id === parsed.current })),
      });
    },
    telemetryCapabilities: telemetryCapabilitiesFor('claude'),
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
      args.push('--', prompt);
      context.onPolicy?.(policyObservation('claude', policy, { builtins, allowed, mode: 'dontAsk', sandbox: settings.sandbox ?? null, panelAccess: context.policy?.access ?? null }));
      let result, sessionId = endpoint.session;
      let assistantModel = null;
      let selectionModel = selectedModel ?? null;
      let lastAssistantUsage = null;
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
          lastAssistantUsage = usage;
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

export function createDshHost({ directory, socketPath, command = 'dsh', model }) {
  if (model) throw new Error('DSH 模型由其 headless profile 设置；本版本不伪造未验证的模型参数');
  return {
    async listModels() {
      const result = await runDshCatalogProbe(command, directory);
      const models = result.providers.flatMap(provider => provider.models ?? []);
      return modelCatalog({
        host: 'dsh',
        source: 'dsh.modelCatalog',
        models,
        defaultModel: models.some(item => item.key === result.defaultModel) ? result.defaultModel : null,
      });
    },
    telemetryCapabilities: telemetryCapabilitiesFor('dsh'),
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
      args.push(`${instructions}\n\n当前输入：\n${prompt}`);
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
