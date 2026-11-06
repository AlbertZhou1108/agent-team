#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve, delimiter, dirname } from 'node:path';
import { mkdirSync, openSync, closeSync, existsSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { socketFor } from './server.mjs';
import { rpc } from './rpc.mjs';
import { nodeRunner } from './runtime.mjs';

export function applicationData({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Agent Team');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Agent Team');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'agent-team');
}

export function launchEnvironment() {
  const env = { ...process.env };
  const key = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const candidates = [join(homedir(), '.local', 'bin'), join(homedir(), '.hermes', 'node', 'bin'), join(homedir(), '.volta', 'bin'), join(homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  // GUI 应用自带的可执行文件目录不是 Node 安装目录，加入 PATH 只会带来误命中的风险。
  if (!process.versions.electron) candidates.push(dirname(process.execPath));
  env[key] = [...new Set([...(env[key] ?? '').split(delimiter), ...candidates].filter(Boolean))].join(delimiter);
  return env;
}

async function readInstance(directory) {
  const instance = await rpc(socketFor(directory), { op: 'instance' }, 1000);
  const url = new URL(instance.url);
  if (realpathSync(instance.directory) !== realpathSync(directory) || !instance.instanceId || !Number.isInteger(instance.pid)
    || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/') {
    throw new Error('本地服务身份无效');
  }
  return instance;
}

// 服务停止/重启的瞬间 socket 仍可能存在,连接会被重置或直接关闭。
// 这类瞬态错误只说明"现在说不清",短暂重试后仍不可达就按未运行处理。
function transientDiscoveryError(error) {
  return ['ECONNRESET', 'EPIPE'].includes(error.code) || error.message === '群总线在返回结果前断开连接';
}

export async function discover(directory) {
  try {
    return await readInstance(directory);
  } catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code) || error.message === '服务尚未就绪') return null;
    if (!transientDiscoveryError(error)) throw error;
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      return await readInstance(directory);
    } catch (retryError) {
      if (transientDiscoveryError(retryError) || ['ENOENT', 'ECONNREFUSED'].includes(retryError.code) || retryError.message === '服务尚未就绪') return null;
      throw retryError;
    }
  }
}

export async function launch({ directory = applicationData(), configFile, port, timeout = 15000 } = {}) {
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let preferredPort = port ?? 0;
  if (port === undefined) {
    try {
      const saved = JSON.parse(readFileSync(join(directory, 'launcher.json'), 'utf8')).port;
      if (Number.isInteger(saved) && saved > 0 && saved <= 65535) preferredPort = saved;
    } catch { /* Discovery is authoritative; this file only remembers an address preference. */ }
  }
  const remember = instance => {
    writeFileSync(join(directory, 'launcher.json'), JSON.stringify({ port: Number(new URL(instance.url).port) }), { mode: 0o600 });
    return instance;
  };
  const existing = await discover(directory);
  if (existing) return remember({ ...existing, reused: true });
  const logPath = join(directory, 'service.log');
  const log = openSync(logPath, 'a', 0o600);
  let child;
  try {
    const args = ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'serve', '--data', directory, '--port', String(preferredPort)];
    if (configFile) args.push('--hosts', resolve(configFile));
    const runner = nodeRunner();
    child = spawn(runner.command, args, { cwd: directory, env: { ...launchEnvironment(), ...runner.env }, detached: true, stdio: ['ignore', log, log], windowsHide: true });
  } finally { closeSync(log); }
  let failure;
  child.once('error', error => { failure = error; });
  child.unref();
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (failure) throw failure;
    const found = await discover(directory);
    if (found) return remember({ ...found, reused: found.pid !== child.pid });
    // A competing launcher may own the lock but not have started IPC yet.
    if (child.exitCode !== null && !existsSync(join(directory, 'owner.json'))) {
      if (port === undefined && preferredPort) return launch({ directory, configFile, port: 0, timeout });
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Never kill a PID from the lock file. Only stop the child this invocation created.
  if (child.exitCode === null) child.kill('SIGTERM');
  throw new Error(`本地服务未能启动，请查看 ${logPath}`);
}

export async function stopService(directory = applicationData()) {
  const instance = await discover(resolve(directory));
  if (!instance) return false;
  await rpc(socketFor(resolve(directory)), { op: 'service_stop', instanceId: instance.instanceId }, 15000);
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (!existsSync(join(directory, 'owner.json')) && !await discover(resolve(directory))) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务仍在停止，请勿替换程序文件');
}

export function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['/usr/bin/open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('浏览器未能打开，请手动访问上面的地址')));
  });
}

async function main() {
  const { values } = parseArgs({ options: { data: { type: 'string' }, hosts: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' }, stop: { type: 'boolean' }, status: { type: 'boolean' } } });
  const directory = values.data ? resolve(values.data) : applicationData();
  if (values.stop) { console.log(await stopService(directory) ? '服务已停止' : '服务未运行'); return; }
  const instance = values.status ? await discover(directory) : await launch({ directory, configFile: values.hosts, port: values.port === undefined ? undefined : Number(values.port) });
  if (!instance) { console.log('服务未运行'); return; }
  console.log(instance.url);
  if (!values['no-open'] && !values.status) await openBrowser(instance.url);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async error => {
    console.error(error.message); process.exitCode = 1;
    if (!process.argv.some(arg => ['--no-open', '--status', '--stop'].includes(arg))) {
      try {
        const directory = applicationData(); mkdirSync(directory, { recursive: true, mode: 0o700 });
        const page = join(directory, 'startup-error.html');
        const text = String(error.message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>Agent Team 启动失败</title><h1>本地服务未能打开</h1><p>${text}</p><p>请检查服务日志后，再次使用启动入口。</p>`, { mode: 0o600 });
        await openBrowser(pathToFileURL(page).href);
      } catch { /* The command entry still prints the failure for diagnosis. */ }
    }
  });
}
