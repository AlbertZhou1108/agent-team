#!/usr/bin/env node
/**
 * 约束域写时自查 hook（PostToolUse，ZCode/Claude Code 兼容输入）：
 * 根据 `scripts/agent-checks.mjs` 注册表按被编辑文件路径分发对应检查脚本，
 * 违例经 additionalContext 回灌给 agent 当场修复。
 * 任何自身错误都静默放行 —— hook 绝不阻塞正常编辑。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatHookContext,
  formatHostHookOutput,
  matchAgentChecks,
} from './agent-checks.mjs';

const main = () => {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const filePath = payload?.tool_input?.file_path ?? payload?.tool_input?.path ?? '';
  const matched = matchAgentChecks(filePath);
  if (!matched.length) return;

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const failures = [];
  for (const entry of matched) {
    const checker = join(repoRoot, entry.check);
    if (!existsSync(checker)) continue;
    const run = spawnSync(process.execPath, [checker], { cwd: repoRoot, encoding: 'utf8' });
    if (run.status !== 0) {
      failures.push({
        entry,
        output: [run.stdout, run.stderr].filter(Boolean).join('\n').trim(),
      });
    }
  }
  if (!failures.length) return;

  const context = formatHookContext(failures);
  process.stdout.write(formatHostHookOutput(context));
};

main();
