#!/usr/bin/env node
/**
 * desktop:dev 的自包含启动器。
 *
 * 以前要先在另一个终端跑 npm run dev，窗口才有 5173 / 62048 可连。
 * 现在改为：已有的服务直接复用，缺哪个启动哪个，等两者就绪后再开窗口。
 * 退出时只回收自己启动的子进程，绝不杀掉复用的服务。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const electron = require('electron');
const API = 'http://127.0.0.1:62048';
const WEB = 'http://127.0.0.1:5173';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const children = [];
const state = { window: null, stopping: false };
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (await reachable(url)) return;
    await sleep(300);
  }
  throw new Error(`${label} 未能在 30s 内就绪`);
}

function stop(code = 0) {
  if (state.stopping) return;
  state.stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  if (state.window && state.window.exitCode === null) state.window.kill('SIGTERM');
  process.exitCode = code;
}

function start(label, command, args) {
  const child = spawn(command, args, { cwd: repo, env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('exit', code => {
    if (state.stopping) return;
    console.error(`[desktop:dev] ${label} 意外退出 (${code})`);
    stop(1);
  });
}

async function main() {
  const apiUp = await reachable(`${API}/api/service`);
  const webUp = await reachable(`${WEB}/`);
  console.log(`[desktop:dev] API ${apiUp ? '复用已有' : '自动启动'} · Vite ${webUp ? '复用已有' : '自动启动'}`);
  if (!apiUp) start('API', process.execPath, [
    '--disable-warning=ExperimentalWarning', 'src/cli.mjs', 'serve',
    '--data', process.env.AGENT_TEAM_DEV_DATA ?? 'work/dev', '--port', '62048',
  ]);
  if (!webUp) start('Vite', process.execPath, [resolve(repo, 'node_modules/vite/bin/vite.js'), '--config', 'web/vite.config.ts']);
  await waitFor(`${API}/api/service`, 'API');
  await waitFor(`${WEB}/`, 'Vite');
  console.log('[desktop:dev] 依赖就绪，打开桌面窗口');
  state.window = spawn(electron, [resolve(here, 'main.mjs'), '--dev', ...process.argv.slice(2)], {
    cwd: repo, env, stdio: 'inherit', windowsHide: true,
  });
  state.window.on('exit', (code, signal) => stop(code ?? (signal ? 1 : 0)));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal === 'SIGINT' ? 0 : 1));
}
main().catch(error => {
  console.error(`[desktop:dev] ${error.message}`);
  stop(1);
});
