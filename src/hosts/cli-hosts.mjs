import { writeMcpFiles, runJsonProcess } from './process.mjs';

export function createClaudeHost({ directory, socketPath, command = 'claude', model, permissionMode = 'dontAsk', allowEdits = false }) {
  return {
    async run(context) {
      const { endpoint, prompt, instructions, onSession, onAccepted } = context;
      const files = writeMcpFiles(directory, socketPath, endpoint, context.turnId);
      const allowed = context.tools.map(tool => `mcp__agent_team__${tool.name}`);
      if (allowEdits) allowed.push('Read', 'Edit', 'Write', 'Glob', 'Grep');
      const args = ['-p', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', files.claude, '--allowedTools', ...allowed, '--permission-mode', permissionMode, '--output-format', 'stream-json', '--verbose', '--append-system-prompt', instructions];
      if (endpoint.session) args.push('--resume', endpoint.session);
      if (model) args.push('--model', model);
      args.push(prompt);
      let result;
      await runJsonProcess(command, args, { ...context, onRow(row) {
        if (row.session_id) onSession(row.session_id);
        if (row.type === 'result') result = row;
      } });
      if (!result || result.is_error) throw new Error(result?.result || 'Claude 未返回可确认的结果');
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
