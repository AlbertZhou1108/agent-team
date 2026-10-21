import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url));

export function writeMcpFiles(directory, socketPath, endpoint, turnId, execution) {
  const dir = resolve(directory, 'endpoints', endpoint.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', cliPath, 'mcp', '--socket', socketPath, '--endpoint', endpoint.id], env: { AGENT_TEAM_KEY: endpoint.key, AGENT_TEAM_TURN: turnId } };
  const claude = resolve(dir, 'claude.json');
  const dsh = resolve(dir, 'dsh.patch.json');
  writeFileSync(claude, JSON.stringify({ mcpServers: { agent_team: config } }), { mode: 0o600 });
  const overlay = [{ insert: [{ id: 'agent-team-mcp', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'agent_team', transport: 'stdio', ...config, failOnStartupError: true, reconnect: { enabled: false } } }] }];
  if (execution) {
    overlay.push(
      { id: 'tools', config: { mode: 'native' } },
      { id: 'session-persistence-jsonl', config: { root: resolve(directory, 'host-sessions', 'dsh') } },
      { id: 'storage-json', config: { root: resolve(directory, 'host-storage', 'dsh') } },
      { id: 'sandbox-policy', config: { mode: execution.mode === 'workspace-write' ? 'workspace-write' : 'read-only', workspaceRoot: execution.workspace } },
      { id: 'approval', config: { policy: 'never' } },
      { id: 'permission', config: { presets: { team: { sandbox: execution.mode === 'workspace-write' ? 'workspace-write' : 'read-only', approval: 'never' } }, defaultPreset: 'team' } },
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
    overlay.push(
      { insert: [{ id: 'agent-team-policy', name: fileURLToPath(new URL('./dsh-policy.mjs', import.meta.url)), config: execution }] },
      { insert: [{ id: 'agent-team-model-observer', name: fileURLToPath(new URL('./dsh-model-observer.mjs', import.meta.url)) }] },
    );
  }
  writeFileSync(dsh, JSON.stringify(overlay), { mode: 0o600 });
  return { claude, dsh };
}

export function runJsonProcess(command, args, { workspace, signal, onEvent, onRow }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('回合已中断'));
    const child = spawn(command, args, { cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', failure, bytes = 0, killTimer;
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 1500);
      killTimer.unref();
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
      clearTimeout(killTimer);
      if (signal.aborted) return reject(new Error('回合已中断'));
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`${command} 退出 (${code ?? reason})：${stderr || '请检查宿主认证、权限与额度'}`));
      resolve();
    });
  });
}
