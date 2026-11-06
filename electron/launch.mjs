#!/usr/bin/env node
/**
 * 桌面开发态入口。
 *
 * 某些 IDE / 终端会在环境里注入 ELECTRON_RUN_AS_NODE=1，Electron 二进制
 * 在这种环境下会退化成纯 Node，连 'electron' 模块都拿不到，窗口根本不会
 * 出现。启动器先清掉它，再用干净的 env 拉起主进程。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const binary = require('electron');
const here = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(binary, [resolve(here, 'main.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit', env, windowsHide: true,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', error => {
  console.error(`无法启动 Electron：${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
