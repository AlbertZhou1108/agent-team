import { spawnHost as spawn, stopHost } from './subprocess.mjs';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxMode } from '../hosts/policies.mjs';
import { nodeRunner } from '../runtime.mjs';

export const cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url));

/**
 * MCP server 的启动命令会被写进宿主配置，由宿主自己的进程 spawn。
 * runner 可注入，便于在契约测试里覆盖 Electron 分支。
 */
export function mcpConfig({ socketPath, endpoint, turnId, runner = nodeRunner(), cli = cliPath }) {
  return {
    command: runner.command,
    args: ['--disable-warning=ExperimentalWarning', cli, 'mcp', '--socket', socketPath, '--endpoint', endpoint.id],
    env: { ...runner.env, AGENT_TEAM_KEY: endpoint.key, AGENT_TEAM_TURN: turnId },
  };
}

export function writeMcpFiles(directory, socketPath, endpoint, turnId, execution) {
  const dir = resolve(directory, 'endpoints', endpoint.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = mcpConfig({ socketPath, endpoint, turnId });
  const claude = resolve(dir, 'claude.json');
  const dsh = resolve(dir, 'dsh.patch.json');
  writeFileSync(claude, JSON.stringify({ mcpServers: { agent_team: config } }), { mode: 0o600 });
  const overlay = [{ insert: [{ id: 'agent-team-mcp', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'agent_team', transport: 'stdio', ...config, failOnStartupError: true, reconnect: { enabled: false } } }] }];
  if (execution) {
    // dsh ≥0.2.2-rc.1 移除了 tools.mode（"Removed. Mount a native or PTC tool
    // executor instead."），原生执行器由 base 默认挂载；再传 native 会使整个
    // tools 行校验失败，连带 agent-loop 等必需插件不激活（no agent factory）。
    overlay.push(
      { id: 'session-persistence-jsonl', config: { root: resolve(directory, 'host-sessions', 'dsh') } },
      { id: 'storage-json', config: { root: resolve(directory, 'host-storage', 'dsh') } },
      { id: 'sandbox-policy', config: { mode: sandboxMode(execution.mode), workspaceRoot: execution.workspace } },
      { id: 'approval', config: { policy: 'never' } },
      { id: 'permission', config: { presets: { team: { sandbox: sandboxMode(execution.mode), approval: 'never' } }, defaultPreset: 'team' } },
    );
    if (execution.modelSelection?.model) {
      if (!execution.modelSelection.model_provider) throw new Error('DSH角色模型缺少model_provider');
      overlay.push({
        id: 'agent-default-model',
        config: {
          provider: execution.modelSelection.model_provider,
          model: execution.modelSelection.model,
          ...(execution.modelSelection.reasoning_effort
            ? { reasoningEffort: execution.modelSelection.reasoning_effort }
            : {}),
        },
      });
    }
    // 这三个插件实现位于 member/dsh/,不是 host-runtime/ —— 路径写错会让 dsh
    // 启动时报 ERR_MODULE_NOT_FOUND 并退出(团队消息投递失败的真正原因)。
    overlay.push(
      { insert: [{ id: 'agent-team-policy', name: fileURLToPath(new URL('../member/dsh/policy.mjs', import.meta.url)), config: execution }] },
      { insert: [{ id: 'agent-team-model-observer', name: fileURLToPath(new URL('../member/dsh/model-observer.mjs', import.meta.url)) }] },
      { insert: [{ id: 'agent-team-telemetry-observer', name: fileURLToPath(new URL('../member/dsh/telemetry-observer.mjs', import.meta.url)) }] },
    );
  }
  writeFileSync(dsh, JSON.stringify(overlay), { mode: 0o600 });
  return { claude, dsh };
}

export function runJsonProcess(command, args, { workspace, signal, onEvent, onRow, env }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('回合已中断'));
    const child = spawn(command, args, { cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    let stderr = '', failure, bytes = 0, stopping;
    const kill = () => {
      stopping ??= stopHost(child).catch(error => { failure = error; reject(error); });
    };
    signal.addEventListener('abort', kill, { once: true });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    createInterface({ input: child.stdout }).on('line', line => {
      bytes += Buffer.byteLength(line);
      if (bytes > 32 * 1024 * 1024) { failure = new Error('单回合输出超过 32 MiB'); kill(); return; }
      if (!line.trim()) return;
      try { const row = JSON.parse(line); onEvent(row); onRow(row); }
      catch (error) { failure = error; kill(); }
    });
    child.on('error', error => { failure = error; });
    child.on('close', (code, reason) => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) return reject(new Error('回合已中断'));
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`${command} 退出 (${code ?? reason})：${stderr || '请检查宿主认证、权限与额度'}`));
      resolve();
    });
  });
}
