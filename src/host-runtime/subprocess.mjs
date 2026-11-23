import crossSpawn from 'cross-spawn';
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, delimiter } from 'node:path';
import which from 'which';
import { nodeRunner } from '../runtime.mjs';

// Keep shell parsing, Windows npm shims and Unix process groups out of adapters.
export function spawnHost(command, args, options = {}) {
  let runnerEnv = {};
  if (process.platform === 'win32') {
    const env = options.env ?? process.env;
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
    const searchPath = [options.cwd ?? process.cwd(), env[pathKey] ?? ''].join(delimiter);
    // 禁止把无 shebang 的 .cjs/.mjs/.js 脚本直接交给 cross-spawn/cmd.exe,
    // 否则 Windows 会通过 ShellExecute 弹出「选择一个应用以打开此文件」窗口。
    if (/\.(?:c|m)?js$/i.test(command) && existsSync(command)) {
      const head = readFileSync(command, 'utf8').slice(0, 2);
      if (head !== '#!') {
        throw new Error(`Windows 下不能直接执行无 shebang 的脚本文件，请经 node 启动: ${command}`);
      }
    }
    const file = which.sync(command, { path: searchPath, nothrow: true });
    if (file && /\.cmd$/i.test(file)) {
      const shim = readFileSync(file, 'utf8');
      const entry = /"(?:%dp0%|%~dp0)[\\/]*([^"\r\n]+\.(?:[cm]?js|exe))"\s+%\*/i.exec(shim);
      if (entry) {
        const target = resolve(dirname(file), entry[1]);
        if (existsSync(target)) {
          if (/\.exe$/i.test(target)) command = target;
          else {
            const localNode = resolve(dirname(file), 'node.exe');
            const runner = existsSync(localNode) ? { command: localNode, env: {} } : nodeRunner();
            command = runner.command;
            runnerEnv = runner.env;
            args = [target, ...args];
          }
        }
      }
    }
  }
  return crossSpawn(command, args, {
    ...options,
    env: { ...(options.env ?? process.env), ...runnerEnv },
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopHost(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let escalation;
    let deadline;
    let settled = false;
    let taskkillDone = false;
    let exited = false;
    const destroyStreams = () => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    let onExit;
    let closed;
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      child.off('close', closed);
      child.off('exit', onExit);
    };
    const failed = error => {
      if (settled) return;
      settled = true;
      cleanup();
      error.runtimeUnknown = true;
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    onExit = () => {
      exited = true;
      if (process.platform === 'win32') {
        // Windows 上后台派生守护进程可能继承管道句柄导致 close 不触发；
        // 主进程退出且 taskkill 树清理完成后销毁流并立即结算。
        destroyStreams();
        if (taskkillDone) finish();
      }
    };
    closed = () => {
      exited = true;
      // A parent may exit on SIGTERM while descendants ignore it.
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') return failed(error); }
        finish();
        return;
      }
      if (taskkillDone) finish();
    };
    deadline = setTimeout(() => failed(new Error('无法确认宿主进程树已停止')), 5000);
    child.once('close', closed);
    child.once('exit', onExit);
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
        if (settled) return;
        const alreadyGone = exited || child.exitCode !== null || child.signalCode !== null || !pidAlive(child.pid);
        if (error && !alreadyGone) {
          try { child.kill(); } catch { /* fall through to error */ }
          if (pidAlive(child.pid)) return failed(error);
        }
        taskkillDone = true;
        destroyStreams();
        if (alreadyGone || !pidAlive(child.pid)) finish();
      });
    } else {
      const kill = signal => {
        try { process.kill(-child.pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') failed(error); }
      };
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 1500);
    }
  });
}
