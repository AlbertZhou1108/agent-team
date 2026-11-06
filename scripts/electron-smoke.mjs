#!/usr/bin/env node
/**
 * Electron 启动冒烟：用隔离的数据目录拉起桌面壳，等待面板加载成功后退出。
 *
 * 覆盖「主进程 + preload + 服务拉起 + 窗口 loadURL」这条真实启动路径；
 * 只验证启动可达，不做交互断言（交互由 test/contract/desktop-helpers.test.mjs 覆盖）。
 * 因为是 GUI 冒烟，默认不进 CI，按发布/桌面改动手动执行：npm run desktop:smoke
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'package.json'));

if (!existsSync(join(root, 'web/dist/index.html'))) {
  console.error('[electron-smoke] 缺少 web/dist/index.html，请先运行 npm run build');
  process.exit(1);
}

const binary = require('electron');
const dataRoot = mkdtempSync(join(tmpdir(), 'agent-team-smoke-'));
const env = {
  ...process.env,
  AGENT_TEAM_SMOKE: '1',
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  // 隔离用户数据目录：macOS/Linux 用 HOME，Windows 用 LOCALAPPDATA/APPDATA。
  HOME: dataRoot,
  XDG_DATA_HOME: join(dataRoot, '.local', 'share'),
  LOCALAPPDATA: join(dataRoot, 'AppData', 'Local'),
  APPDATA: join(dataRoot, 'AppData', 'Roaming'),
};
delete env.ELECTRON_RUN_AS_NODE;

// 隔离 Electron 自身的 userData / 单实例锁,避免和正在运行的桌面窗口抢锁。
const userData = join(dataRoot, 'electron');
const child = spawn(binary, [
  join(root, 'electron/main.mjs'),
  '--no-sandbox',
  `--user-data-dir=${userData}`,
], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let settled = false;
let output = '';
const timeout = setTimeout(() => finish(1, '等待面板加载超时（30s）'), 30000);

function stopService() {
  return new Promise(resolve => {
    const stopper = spawn(process.execPath, [join(root, 'src/launcher.mjs'), '--stop'], {
      env, stdio: 'ignore', windowsHide: true,
    });
    stopper.once('exit', resolve);
    stopper.once('error', resolve);
  });
}

async function finish(code, message) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  child.kill('SIGTERM');
  await stopService();
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  if (message) console[code === 0 ? 'log' : 'error'](`[electron-smoke] ${message}`);
  process.exit(code);
}

child.stdout.on('data', chunk => {
  output += chunk;
  if (output.includes('AGENT_TEAM_SMOKE_READY')) finish(0, '通过：窗口已加载面板并正常退出');
  if (output.includes('AGENT_TEAM_SMOKE_FAILED')) finish(1, '面板加载失败');
});
child.stderr.on('data', chunk => process.stderr.write(chunk));
child.once('error', error => finish(1, `无法启动 Electron：${error.message}`));
child.once('exit', code => {
  if (!settled) finish(code === 0 ? 1 : 1, `Electron 提前退出（code ${code}）\n${output.trim()}`);
});
