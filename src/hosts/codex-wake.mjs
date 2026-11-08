import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { version } from '../version.mjs';
import { spawnHost, stopHost } from './subprocess.mjs';

function tomlValue(value) {
  return JSON.stringify(value);
}

function serverConfigArgs(mcpConfig) {
  if (!mcpConfig?.command || !Array.isArray(mcpConfig.args)) return [];
  const env = `{ ${Object.entries(mcpConfig.env ?? {}).map(([key, value]) => `${key} = ${tomlValue(value)}`).join(', ')} }`;
  return [
    '-c', `mcp_servers.agent_team.command=${tomlValue(mcpConfig.command)}`,
    '-c', `mcp_servers.agent_team.args=${JSON.stringify(mcpConfig.args)}`,
    '-c', `mcp_servers.agent_team.env=${env}`,
    '-c', 'mcp_servers.agent_team.default_tools_approval_mode="approve"',
    '-c', 'mcp_servers.agent_team.startup_timeout_sec=120',
  ];
}

export function codexWakeFingerprint({ command, threadId, mcpConfig }) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    command,
    threadId,
    mcp: {
      command: mcpConfig?.command ?? null,
      args: mcpConfig?.args ?? [],
      envKeys: Object.keys(mcpConfig?.env ?? {}).sort(),
    },
  }));
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  try {
    const file = join(codexHome, 'config.toml');
    hash.update(readFileSync(file));
    const stat = statSync(file);
    hash.update(String(stat.size));
  } catch {
    hash.update('config-unavailable');
  }
  return hash.digest('hex');
}

/**
 * Queue a wake prompt into an existing Codex thread through app-server.
 * The app-server loads the user's provider configuration, while Agent Team
 * injects only its own MCP server. Success means a real turn/started event.
 */
export async function wakeCodexAppServer({
  command = 'codex',
  threadId,
  text,
  cwd,
  mcpConfig,
  timeout = 8 * 60 * 1000,
}) {
  if (!threadId) return { supported: false, reason: '缺少 controller session' };
  if (!text?.trim()) throw new Error('主动唤醒正文为空');
  const child = spawnHost(command, [
    'app-server', '--stdio',
    ...serverConfigArgs(mcpConfig),
  ], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin.on('error', () => {});
  let stderr = '';
  let nextId = 0;
  let started;
  let completed;
  const startedPromise = new Promise((resolve, reject) => {
    started = { resolve, reject };
  });
  const completedPromise = new Promise((resolve, reject) => {
    completed = { resolve, reject };
  });
  const pending = new Map();
  const timer = setTimeout(() => {
    const error = new Error('Codex 主动唤醒超时');
    for (const entry of pending.values()) entry.reject(error);
    started.reject(error);
    completed.reject(error);
  }, timeout);
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const fingerprint = codexWakeFingerprint({ command, threadId, mcpConfig });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });
  child.on('error', error => started.reject(error));
  child.on('exit', (code, signal) => {
    const error = new Error(`Codex app-server 退出 (${code ?? signal})：${stderr.trim()}`);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    started.reject(error);
    completed.reject(error);
  });
  createInterface({ input: child.stdout }).on('line', line => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (row.id && !row.method) {
      const entry = pending.get(row.id);
      if (!entry) return;
      pending.delete(row.id);
      if (row.error) entry.reject(new Error(row.error.message));
      else entry.resolve(row.result);
      return;
    }
    if (row.method === 'turn/started' && row.params?.threadId === threadId) {
      started.resolve(row.params.turn ?? {});
    }
    if (row.method === 'turn/completed' && row.params?.threadId === threadId) {
      completed.resolve(row.params.turn ?? {});
    }
  });
  try {
    await request('initialize', {
      clientInfo: { name: 'agent-team-wake', version },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized' });
    await request('thread/resume', {
      threadId,
      ...(cwd ? { cwd } : {}),
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    const clientUserMessageId = randomUUID();
    const queued = await request('thread/queue/add', {
      threadId,
      clientUserMessageId,
      input: [{ type: 'text', text }],
    });
    const queuedSubmissionId = queued?.queuedSubmission?.id;
    if (!queuedSubmissionId) throw new Error('Codex 队列未返回 submission id');
    const startedTurn = await startedPromise;
    const finalTurn = await completedPromise;
    if (finalTurn.status && !['completed', 'inProgress'].includes(finalTurn.status)) {
      return {
        supported: true,
        state: 'failed',
        mode: 'codex',
        reason: finalTurn.error?.message ?? `Codex 回合状态 ${finalTurn.status}`,
        fingerprint,
        threadId,
        turnId: startedTurn?.id ?? finalTurn.id ?? null,
        queuedSubmissionId,
      };
    }
    return {
      supported: true,
      state: 'started',
      mode: 'codex',
      fingerprint,
      threadId,
      turnId: startedTurn?.id ?? finalTurn.id ?? null,
      queuedSubmissionId,
    };
  } finally {
    clearTimeout(timer);
    await stopHost(child).catch(() => {});
  }
}
