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

export function stopHost(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let escalation;
    const deadline = setTimeout(() => failed(new Error('无法确认宿主进程树已停止')), 5000);
    function failed(error) { cleanup(); error.runtimeUnknown = true; reject(error); }
    function cleanup() { clearTimeout(deadline); clearTimeout(escalation); child.off('close', closed); }
    function closed() {
      // A parent may exit on SIGTERM while descendants ignore it.
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') return failed(error); }
      }
      cleanup(); resolve();
    };
    child.once('close', closed);
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
        if (error && child.exitCode === null && child.signalCode === null) failed(error);
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
