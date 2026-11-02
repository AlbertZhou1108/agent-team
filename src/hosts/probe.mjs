import { version } from '../version.mjs';
import { createInterface } from 'node:readline';
import { spawnHost, stopHost } from './subprocess.mjs';

// A probe owns its process. Completion (including cancellation) always waits for teardown.
export async function exchange(command, args, { initial, receive, signal, timeout = 20000, cwd, env, waitForExit = false } = {}) {
  signal?.throwIfAborted();
  const child = spawnHost(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let timer, failure, cleanupFailure, value, bytes = 0, stderr = '', lines, rejectPending, received;
  const abort = () => rejectPending(signal.reason ?? new Error('检测已取消'));
  try {
    value = await new Promise((resolve, reject) => {
      rejectPending = reject;
      timer = setTimeout(() => reject(new Error('宿主通信检测超时')), timeout);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const send = message => child.stdin.write(JSON.stringify(message) + '\n');
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) reject(new Error('宿主检测输出过大'));
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); bytes += chunk.length; if (bytes > 2 * 1024 * 1024) reject(new Error('宿主检测输出过大')); });
      child.on('error', reject);
      child.on('close', code => {
        if (waitForExit && code === 0 && received !== undefined) resolve(received);
        else reject(new Error(stderr.trim() || `宿主在完成检测前退出 (${code})`));
      });
      lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (!line.trim()) return;
        try {
          const result = receive(line, send);
          if (result !== undefined) { received = result; if (!waitForExit) resolve(result); }
        } catch (error) { reject(error); }
      });
      if (initial) send(initial);
    });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    lines?.close();
    try { await stopHost(child); }
    catch (error) { cleanupFailure = error; }
  }
  if (cleanupFailure) throw new Error('无法确认检测进程已停止', { cause: cleanupFailure });
  if (failure) throw failure;
  return value;
}

export function probeCodex(command, options = {}) {
  return exchange(command, ['app-server', '--stdio'], {
    ...options,
    initial: { id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-team-probe', version }, capabilities: {} } },
    receive(line, send) {
      const row = JSON.parse(line);
      if (row.id === 1) {
        if (row.error || !row.result) throw new Error(row.error?.message || 'Codex 初始化响应无效');
        send({ method: 'initialized' });
        send({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: false } });
      }
      if (row.id === 2) {
        if (row.error || !Array.isArray(row.result?.data) || !row.result.data.length) throw new Error(row.error?.message || 'Codex 模型响应无效');
        return { connected: true };
      }
    },
  });
}

export function initializeClaude(command, { configDirectory, ...options } = {}) {
  return exchange(command, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', 'user', '--settings', JSON.stringify({ disableAllHooks: true }),
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--tools', '', '--permission-mode', 'dontAsk', '--no-session-persistence',
  ], {
    ...options,
    env: { ...process.env, ...(configDirectory ? { CLAUDE_CONFIG_DIR: configDirectory } : {}) },
    initial: { type: 'control_request', request_id: 'agent-team-probe', request: { subtype: 'initialize' } },
    receive(line) {
      const row = JSON.parse(line);
      if (row.type === 'assistant') throw new Error('检测收到意外模型消息');
      if (row.type !== 'control_response' || row.response?.request_id !== 'agent-team-probe') return;
      if (row.response.subtype !== 'success') throw new Error(row.response.error || 'Claude 初始化失败');
      return row.response.response ?? {};
    },
  });
}

export async function probeClaude(command, options = {}) {
  const initialized = await initializeClaude(command, options);
  if (!Array.isArray(initialized.models) || !initialized.models.length) throw new Error('Claude 未提供可用模型目录，请检查宿主版本与配置');
  return { connected: true };
}

export function connectionProbe(lifecycle, probe) {
  let pending, previous, controller;
  return {
    connectionStatus: () => pending ? { status: 'checking' } : previous ?? { status: 'unchecked' },
    async cancelProbe() { controller?.abort(new Error('检测已取消')); await pending; },
    probeConnection() {
      if (!pending) {
        controller = new AbortController();
        pending = (async () => {
          const installed = await lifecycle.checkStatus();
          if (installed.status !== 'available' || installed.installing) return installed;
          controller.signal.throwIfAborted();
          await probe(controller.signal);
          return { status: 'available' };
        })().catch(error => ({ status: 'error', reason: error.message }))
          .then(value => { previous = value; return value; })
          .finally(() => { pending = null; });
      }
      return pending;
    },
  };
}
