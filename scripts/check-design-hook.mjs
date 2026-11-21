#!/usr/bin/env node
/**
 * 设计治理写时自查 hook（PostToolUse，ZCode/Claude Code 兼容输入）：
 * agent 编辑 web/src 下文件后自动跑 check-design.mjs，违例经
 * additionalContext 回灌给 agent，当场修复而不是等到提交门禁。
 * 任何自身错误都静默放行 —— hook 绝不阻塞正常编辑。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (!filePath || !/[\\/]web[\\/]src[\\/]/.test(filePath)) return;

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const checker = join(repoRoot, 'scripts', 'check-design.mjs');
  if (!existsSync(checker)) return;

  const run = spawnSync(process.execPath, [checker], { cwd: repoRoot, encoding: 'utf8' });
  if (run.status === 0) return;

  const problems = [run.stdout, run.stderr].filter(Boolean).join('\n').trim();
  const context = [
    '⚠️ 设计治理违例（刚编辑的文件触发 check-design.mjs）——当场修复，不要留到提交：',
    problems || '(违例明细缺失，请自行运行 node scripts/check-design.mjs 查看)',
  ].join('\n');
  // 输出格式按宿主区分（环境变量由宿主注入）：Claude Code 的 additionalContext
  // 需要包在 hookSpecificOutput 内，ZCode 用顶层 additionalContext，两者 schema 都严格。
  if (process.env.CLAUDE_PROJECT_DIR && !process.env.ZCODE_PROJECT_DIR) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
    }));
    return;
  }
  process.stdout.write(JSON.stringify({ additionalContext: context }));
};

main();
