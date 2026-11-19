import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawnHost, stopHost } from '../subprocess.mjs';

/**
 * DSH 主动唤醒驱动：DSH 没有常驻服务也能唤醒——headless profile 的
 * `--session-id` 会采用（adopt）已持久化的会话续聊，未知 id 直接报错。
 * 唤醒即"每回合一个进程"：spawn `dsh --profile headless --patch <overlay>
 * --session-id <id> --json --approval-policy never "<正文>"`，进程退出即回合结束。
 * agent_team MCP server 经 overlay 注入（与成员适配器同机制），无需用户配置。
 */

function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
}

export function dshWakeFingerprint({ command, threadId, mcpConfig }) {
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
  const file = join(dshHome(), 'cordis.patch.yml');
  try {
    hash.update(readFileSync(file));
    hash.update(String(statSync(file).size));
  } catch {
    hash.update('config-unavailable');
  }
  return hash.digest('hex');
}

function writeWakeOverlay(mcpConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-dsh-wake-'));
  const overlay = [
    { insert: [{
      id: 'agent-team-mcp',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'agent_team',
        transport: 'stdio',
        command: mcpConfig?.command,
        args: mcpConfig?.args ?? [],
        ...(mcpConfig?.env ? { env: mcpConfig.env } : {}),
        failOnStartupError: true,
        reconnect: { enabled: false },
      },
    }] },
  ];
  const file = join(directory, 'wake.patch.json');
  writeFileSync(file, JSON.stringify(overlay), { mode: 0o600 });
  return { directory, file };
}

export async function wakeDshSession({
  command = 'dsh',
  threadId,
  text,
  cwd,
  mcpConfig,
  timeout = 8 * 60 * 1000,
  env,
}) {
  if (!threadId) return { supported: false, reason: '缺少 controller session' };
  if (!text?.trim()) throw new Error('主动唤醒正文为空');
  const fingerprint = dshWakeFingerprint({ command, threadId, mcpConfig });
  const overlay = writeWakeOverlay(mcpConfig);
  const args = [
    '--profile', 'headless',
    '--patch', overlay.file,
    '--json',
    '--session-id', threadId,
    '--approval-policy', 'never',
    text,
  ];
  const child = spawnHost(command, args, {
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  let stderr = '';
  let finalText;
  let endReason;
  let failure;
  let bytes = 0;
  const timer = setTimeout(() => {
    failure = new Error('DSH 主动唤醒超时');
    stopHost(child).catch(() => {});
  }, timeout);
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
  createInterface({ input: child.stdout }).on('line', line => {
    bytes += Buffer.byteLength(line);
    if (bytes > 32 * 1024 * 1024) {
      failure ??= new Error('唤醒回合输出超过 32 MiB');
      stopHost(child).catch(() => {});
      return;
    }
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row.type === 'session' && row.sessionId) threadId = row.sessionId;
    if (row.type === 'final') finalText = row.text;
    if (row.type === 'status' && row.phase === 'turn_end') endReason = row.reason?.kind;
    if (row.type === 'error') failure ??= new Error(row.message ?? row.error ?? 'DSH 回合失败');
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
  clearTimeout(timer);
  rmSync(overlay.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  if (failure) {
    stopHost(child).catch(() => {});
    return {
      supported: true,
      state: 'failed',
      mode: 'dsh',
      reason: failure.message,
      fingerprint,
      sessionId: threadId,
    };
  }
  if (exitCode !== 0 || endReason !== 'completed') {
    return {
      supported: true,
      state: 'failed',
      mode: 'dsh',
      reason: stderr.trim() || (endReason ? `DSH 回合结束原因：${endReason}` : `DSH 退出 (${exitCode ?? 'unknown'})`),
      fingerprint,
      sessionId: threadId,
    };
  }
  return {
    supported: true,
    state: 'started',
    mode: 'dsh',
    fingerprint,
    sessionId: threadId,
    ...(finalText !== undefined ? { response: finalText } : {}),
  };
}
