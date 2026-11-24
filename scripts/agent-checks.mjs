/**
 * Agent 写时约束域注册表（单一事实源：hook、AGENTS.md 自检与提交门禁共用同一批检查脚本）。
 *
 * 新增约束域只需三步：
 *   1. 在 `scripts/` 落一个 <1s、违例带文件行号、失败非零退出的检查脚本；
 *   2. 在 `AGENT_CHECKS` 增加一条 `{ name, label, match, check, advice }`；
 *   3. 在 `AGENTS.md` 同步自检提示。
 */
export const AGENT_CHECKS = [
  {
    name: 'design',
    label: '设计治理',
    match: /(?:^|\/)web\/src\//,
    check: 'scripts/check-design.mjs',
    advice: '当场修复，不要留到提交',
  },
  {
    name: 'layering',
    label: '纯 Web 分层',
    match: /(?:^|\/)web\/(?:src|tests)\//,
    check: 'scripts/check-layering.mjs',
    advice: 'web/ 必须保持纯 Web，不要导入根目录 src/ 或 electron/',
  },
];

/** 归一化路径分隔符，确保 Windows 与 POSIX 路径都能命中注册表。 */
export function normalizeCheckPath(filePath) {
  return String(filePath ?? '').replaceAll('\\', '/');
}

/** 按被编辑文件路径匹配需要触发的约束域检查项。 */
export function matchAgentChecks(filePath) {
  const normalized = normalizeCheckPath(filePath);
  if (!normalized) return [];
  return AGENT_CHECKS.filter(entry => entry.match.test(normalized));
}

/** 汇总失败检查项的 stdout+stderr 为回灌给 Agent 的上下文提示。 */
export function formatHookContext(failures) {
  if (!failures.length) return '';
  return failures
    .map(({ entry, output }) => [
      `⚠️ ${entry.label}违例（刚编辑的文件触发 ${entry.check}）——${entry.advice}：`,
      output || `(违例明细缺失，请自行运行 node ${entry.check} 查看)`,
    ].join('\n'))
    .join('\n\n');
}

/**
 * 按宿主环境变量格式化 PostToolUse 输出：
 * Claude Code 要求包在 hookSpecificOutput 内，ZCode 使用顶层 additionalContext。
 */
export function formatHostHookOutput(context, env = process.env) {
  if (env.CLAUDE_PROJECT_DIR && !env.ZCODE_PROJECT_DIR) {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
    });
  }
  return JSON.stringify({ additionalContext: context });
}
