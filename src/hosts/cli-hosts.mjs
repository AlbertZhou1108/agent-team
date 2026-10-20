import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeMcpFiles, runJsonProcess } from './process.mjs';

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

export function createClaudeHost({
  directory, socketPath, command = 'claude', model, reasoningEffort,
  permissionMode = 'dontAsk', allowEdits = false, configDirectory,
}) {
  if (reasoningEffort && !efforts.has(reasoningEffort)) throw new Error(`Claude 思考强度无效: ${reasoningEffort}`);
  configDirectory ??= process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const verified = new Map();
  return {
    async run(context) {
      const { endpoint, prompt, instructions, onSession, onAccepted } = context;
      const files = writeMcpFiles(directory, socketPath, endpoint, context.turnId);
      const allowed = context.tools.map(tool => `mcp__agent_team__${tool.name}`);
      if (allowEdits) allowed.push('Read', 'Edit', 'Write', 'Glob', 'Grep');
      const settings = { disableAllHooks: true };
      if (reasoningEffort) settings.env = { CLAUDE_CODE_EFFORT_LEVEL: reasoningEffort };
      const args = ['-p', '--setting-sources', 'user', '--settings', JSON.stringify(settings), '--strict-mcp-config', '--mcp-config', files.claude, '--allowedTools', ...allowed, '--permission-mode', permissionMode, '--output-format', 'stream-json', '--verbose', '--append-system-prompt', instructions];
      if (endpoint.session) args.push('--resume', endpoint.session);
      if (model) args.push('--model', model);
      if (reasoningEffort) args.push('--effort', reasoningEffort);
      args.push(prompt);
      let result, sessionId = endpoint.session;
      let assistantModel = null;
      if (model || reasoningEffort) context.onModel({ phase: 'requested', model: model ?? null, reasoningEffort: reasoningEffort ?? null, source: 'adapter.config' });
      await runJsonProcess(command, args, { ...context, onRow(row) {
        if (row.session_id && row.session_id !== sessionId) { sessionId = row.session_id; onSession(sessionId); }
        if (row.type === 'system' && row.subtype === 'init' && row.model) {
          context.onModel({ phase: 'session', model: row.model, provider: 'claude', source: 'claude.system.init' });
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
    async run(context) {
      const { endpoint, prompt, instructions, onSession, onAccepted } = context;
      const files = writeMcpFiles(directory, socketPath, endpoint, context.turnId);
      const args = ['headless', '--patch', files.dsh, '--json'];
      if (endpoint.session) args.push('--session-id', endpoint.session);
      args.push(`${instructions}\n\n当前输入：\n${prompt}`);
      let text, end;
      await runJsonProcess(command, args, { ...context, onRow(row) {
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
