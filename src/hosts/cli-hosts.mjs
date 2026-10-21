import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { writeMcpFiles, runJsonProcess } from './process.mjs';
import { executionPolicy, claudeBuiltins, policyObservation } from './policies.mjs';
import { modelCatalog } from './catalog.mjs';

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
    async run(context) {
      const { endpoint, prompt, instructions, onSession, onAccepted } = context;
      const selectedModel = context.modelSelection?.model ?? model;
      const selectedEffort = context.modelSelection?.reasoning_effort ?? reasoningEffort;
      const policy = executionPolicy(context);
      const files = writeMcpFiles(directory, socketPath, endpoint, context.turnId);
      const allowed = context.tools.map(tool => `mcp__agent_team__${tool.name}`);
      const builtins = claudeBuiltins(policy);
      allowed.push(...builtins);
      const settings = { disableAllHooks: true };
      if (policy.allowShell) settings.sandbox = { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true, ...(policy.mode === 'read-only' ? { filesystem: { denyWrite: [context.workspace] } } : {}) };
      if (selectedEffort) settings.env = { CLAUDE_CODE_EFFORT_LEVEL: selectedEffort };
      const args = ['-p', '--setting-sources', 'user', '--settings', JSON.stringify(settings), '--strict-mcp-config', '--mcp-config', files.claude, '--tools', builtins.join(','), '--allowedTools', allowed.join(','), '--permission-mode', 'dontAsk', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', instructions];
      if (endpoint.session) args.push('--resume', endpoint.session);
      if (selectedModel) args.push('--model', selectedModel);
      if (selectedEffort) args.push('--effort', selectedEffort);
      args.push('--', prompt);
      context.onPolicy?.(policyObservation('claude', policy, { builtins, allowed, mode: 'dontAsk', sandbox: settings.sandbox ?? null }));
      let result, sessionId = endpoint.session;
      let assistantModel = null;
      let selectionModel = selectedModel ?? null;
      if (selectedModel || selectedEffort) context.onModel({ phase: 'requested', model: selectedModel ?? null, reasoningEffort: selectedEffort ?? null, source: context.modelSelection ? 'member.selection' : 'adapter.config' });
      await runJsonProcess(command, args, { ...context, onRow(row) {
        if (row.session_id && row.session_id !== sessionId) { sessionId = row.session_id; onSession(sessionId); }
        if (row.type === 'system' && row.subtype === 'init' && row.model) {
          selectionModel = row.model;
          context.onModel({ phase: 'session', model: row.model, provider: 'claude', source: 'claude.system.init' });
          context.onSelection?.({ model: row.model, reasoning_effort: selectedEffort ?? null });
        }
        if (row.type === 'assistant' && row.message?.model && row.message.model !== assistantModel) {
          assistantModel = row.message.model;
          context.onModel({ phase: 'assistant', model: assistantModel, provider: 'claude', source: 'claude.assistant.message' });
        }
        if (row.type === 'result') result = row;
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
    async run(context) {
      const { endpoint, prompt, instructions, onSession, onAccepted } = context;
      const policy = executionPolicy(context);
      const files = writeMcpFiles(directory, socketPath, endpoint, context.turnId, {
        ...policy,
        workspace: context.workspace,
        tools: context.tools.map(t => `mcp__agent_team__${t.name}`),
        modelSelection: context.modelSelection,
      });
      const args = ['headless', '--patch', files.dsh, '--json'];
      if (endpoint.session) args.push('--session-id', endpoint.session);
      args.push(`${instructions}\n\n当前输入：\n${prompt}`);
      context.onPolicy?.(policyObservation('dsh', policy, { sessionPolicy: policy.mode === 'workspace-write' ? 'workspace-write' : 'read-only', agentScopedToolRestriction: true, approval: 'never' }));
      let text, end;
      await runJsonProcess(command, args, { ...context, onRow(row) {
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
