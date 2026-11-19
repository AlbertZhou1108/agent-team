/**
 * 成员执行能力的唯一裁剪实现（S2）。
 *
 * 输入是宿主 traits 与本次群策略，输出与改造前的四份 `executionCapabilities`
 * 逐字段一致：`{ effectivePolicy, capabilities, reason }`。
 *
 * 输出使用统一词汇 `exec.read / exec.write / exec.shell`。旧词
 * （`file.read / file.write / shell.exec / filesystem.boundary`）只在读取侧
 * 由 `canonicalMemberCapabilityIds` 归一化，不再从这里产出。
 *
 * traits 只表达真实差异，不为了"统一"抹平：
 * - requiresShellForProject：项目操作依赖沙箱命令，未启用 shell 时整类降级（Codex）；
 * - readOnlyKeepsShell：只读策略下仍保留只读沙箱 shell（Codex）；
 * - boundaryUnsupported：某些平台无法保证写边界（Claude / win32）；
 * - noShellReason：未启用 shell 时的降级说明文案（ZCode 与默认文案不同）。
 */
export function memberExecutionCapabilities(traits = {}, { mode, allowShell, platform = process.platform } = {}) {
  if (mode === 'communication') {
    return { effectivePolicy: 'communication', capabilities: [], reason: '仅允许团队通信' };
  }
  if (traits.requiresShellForProject && !allowShell) {
    return {
      effectivePolicy: 'communication',
      capabilities: [],
      reason: 'Codex 项目操作依赖沙箱命令，当前群未启用 shell',
    };
  }
  if (mode === 'read-only') {
    return traits.readOnlyKeepsShell
      ? {
        effectivePolicy: 'read-only',
        capabilities: ['exec.read', 'exec.shell'],
        reason: '群策略只允许读取，shell 运行在只读沙箱',
      }
      : { effectivePolicy: 'read-only', capabilities: ['exec.read'], reason: '群策略只允许读取' };
  }
  const boundary = traits.boundaryUnsupported;
  if (Array.isArray(boundary?.platforms) && boundary.platforms.includes(platform)) {
    return { effectivePolicy: 'read-only', capabilities: ['exec.read'], reason: boundary.reason };
  }
  return {
    effectivePolicy: 'workspace-write',
    capabilities: ['exec.read', 'exec.write', ...(allowShell ? ['exec.shell'] : [])],
    reason: allowShell ? null : (traits.noShellReason ?? '未启用 shell；仍允许受限文件编辑'),
  };
}
