#!/usr/bin/env node
/**
 * 后端覆盖率（P3-2）：Node 内建 test coverage，只统计 `src/**` 产品代码。
 *
 * 设计约定：
 * - 只产出报告，不设阈值、不阻断 `npm test`；需要门禁时再单独加 `--test-coverage-*` 阈值。
 * - 不用 shell glob（spawnSync 直接传目录），三平台行为一致。
 * - 覆盖率工具选择 Node 22 内建 `--experimental-test-coverage`，不引入 c8。
 */
import { spawnSync } from 'node:child_process';

const args = [
  '--disable-warning=ExperimentalWarning',
  '--experimental-test-coverage',
  '--test-coverage-include=src/**',
  '--test',
  // Node 22 的 --test 自己展开 glob；不经过 shell，三平台一致。
  'test/contract/*.test.mjs',
  'test/internal/*.test.mjs',
  'test/process/*.test.mjs',
];

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
