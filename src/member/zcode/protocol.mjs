import { createInterface } from 'node:readline';
import { spawnHost, stopHost } from '../../host-runtime/subprocess.mjs';

/**
 * 无头协议会话的默认反向请求应答：权限审批没有人可点，选允许类选项的
 * response 载荷放行（{decision:'allow',...}，与桌面端行为一致）。
 * 工具面与边界由框架侧（群策略、团队工具白名单）负责，这里只保证回合
 * 不被权限审批卡死。其余请求回最小合法结果。
 */
export function headlessInteractionReply(method, params) {
  if (method === 'interaction/requestPermission') {
    const options = Array.isArray(params?.options) ? params.options : [];
    const option = options.find(item => String(item?.kind ?? '').startsWith('allow'))
      ?? options.find(item => String(item?.optionId ?? '').startsWith('allow'))
      ?? options[0];
    return option?.response ?? { decision: 'allow' };
  }
  return { nativeSearchEnhancementsEnabled: false };
}

/**
 * ZCode Protocol 客户端公共层（宿主为 `zcode.cjs app-server --stdio`）。
 * 负责：spawn、启动握手（storagePath → storagePathReady → 首个 startup 通知即就绪）、
 * JSON-RPC 请求分发、服务端反向请求应答、退出时统一失败。
 * wake 驱动与成员适配器共享这一层，各自只关心业务事件。
 */
export function createZcodeProtocol({ command, args, env, onNotification, onRequest, stderrLimit = 8000 } = {}) {
  const child = spawnHost(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let stderr = '';
  let nextId = 0;
  let exitFailure = null;
  let readyDone = false;
  const pending = new Map();
  const exitWaiters = new Set();
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-stderrLimit); });
  const settleExit = () => {
    if (exitFailure === null) return false;
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      entry.reject(exitFailure);
    }
    for (const waiter of [...exitWaiters]) {
      exitWaiters.delete(waiter);
      waiter(exitFailure);
    }
    return true;
  };
  child.on('error', error => { exitFailure ??= error; settleExit(); });
  child.on('exit', (code, signal) => {
    exitFailure ??= new Error(`ZCode app-server 退出 (${code ?? signal})：${stderr.trim()}`);
    settleExit();
  });
  let readyResolve;
  const ready = new Promise((resolve, reject) => {
    readyResolve = () => { readyDone = true; resolve(); };
    exitWaiters.add(error => reject(error));
  });
  createInterface({ input: child.stdout }).on('line', line => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row.id && !row.method) {
      const entry = pending.get(row.id);
      if (!entry) return;
      pending.delete(row.id);
      if (row.error) entry.reject(new Error(row.error.message));
      else entry.resolve(row.result);
      return;
    }
    if (row.method === 'startup/storagePath') {
      send({ method: 'startup/storagePathReady' });
      return;
    }
    if (row.method?.startsWith('startup/')) {
      if (!readyDone) {
        readyDone = true;
        readyResolve();
      }
      onNotification?.(row);
      return;
    }
    // 服务端反向请求（requestRuntimePreferences 等）：交由调用方应答，缺省回最小合法结果。
    if (row.id && row.method) {
      let result;
      try { result = onRequest?.(row.method, row.params ?? {}); }
      catch { result = {}; }
      send({ id: row.id, result: result ?? {} });
      return;
    }
    onNotification?.(row);
  });
  return {
    child,
    ready,
    request(method, params, { timeout } = {}) {
      if (exitFailure !== null) return Promise.reject(exitFailure);
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        let timer = null;
        const entry = {
          resolve: value => { clearTimeout(timer); pending.delete(id); resolve(value); },
          reject: error => { clearTimeout(timer); pending.delete(id); reject(error); },
        };
        if (timeout) {
          timer = setTimeout(() => {
            if (pending.delete(id)) reject(new Error(`${method} 请求超时`));
          }, timeout);
        }
        pending.set(id, entry);
        send({ id, method, params });
      });
    },
    notify(method, params) {
      send({ method, params });
    },
    stderr: () => stderr,
    stop() {
      return stopHost(child).catch(() => {});
    },
  };
}
