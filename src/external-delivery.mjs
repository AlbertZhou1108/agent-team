import { wakeDriverFor } from './hosts/wake-drivers.mjs';

function wakeText({ teamName, count, verification }) {
  if (verification) {
    return [
      '[Agent Team]',
      '这是主动唤醒能力自检，不是业务消息。',
      '请调用 control_protocol，然后简短确认主动唤醒可用；不要调用 control_inbox。',
    ].join('\n');
  }
  return [
    '[Agent Team]',
    `团队「${teamName}」有 ${count} 条待处理事件。`,
    '请调用 control_inbox 领取。收件箱领取只表示输入已被客户端接受，不代表任务已完成。',
  ].join('\n');
}

/**
 * 主动唤醒与控制工具的“领取”分离：
 * - wake 只负责让宿主现有会话开始一个回合；
 * - 事件仍保持 pending，直到 control_inbox 真正领取。
 */
export function externalWakePlan(binding, { teamName, count, workspace, verification = false }) {
  if (!binding || binding.status !== 'active') {
    return { supported: false, reason: 'active controller binding 不存在或已禁用' };
  }
  if (!binding.session) {
    return { supported: false, reason: '尚未发现宿主 session；请在宿主会话内调用 control_protocol 完成绑定' };
  }
  const driver = wakeDriverFor(binding.host);
  if (!driver) {
    return { supported: false, reason: `宿主 ${binding.host} 尚未声明现有会话唤醒适配器` };
  }
  let wakeConfig;
  try { wakeConfig = binding.wake_config ? JSON.parse(binding.wake_config) : null; }
  catch { wakeConfig = null; }
  if (!wakeConfig?.command || !Array.isArray(wakeConfig.args)) {
    return { supported: false, reason: 'Codex binding 缺少 MCP 唤醒配置；请先在宿主内调用 control_protocol' };
  }
  const command = binding.command || 'codex';
  return {
    supported: true,
    driver: driver.id,
    command,
    threadId: binding.session,
    cwd: workspace ?? null,
    mcpConfig: wakeConfig,
    fingerprint: driver.fingerprint?.({ command, threadId: binding.session, mcpConfig: wakeConfig }) ?? null,
    wake: driver.wake,
    text: wakeText({ teamName, count, verification }),
    timeoutMs: 8 * 60 * 1000,
  };
}

export async function deliverExternalWake(binding, options, { wake = null } = {}) {
  const plan = externalWakePlan(binding, options);
  if (!plan.supported) return plan;
  if (!options.verification && binding.wake_fingerprint && binding.wake_fingerprint !== plan.fingerprint) {
    return {
      supported: true,
      state: 'failed',
      mode: 'codex',
      reason: '主动唤醒环境已变化，需要重新执行验证',
      fingerprint: plan.fingerprint,
    };
  }
  return (wake ?? plan.wake)({
    driver: plan.driver,
    command: plan.command,
    threadId: plan.threadId,
    text: plan.text,
    cwd: plan.cwd,
    mcpConfig: plan.mcpConfig,
    timeout: plan.timeoutMs,
  });
}
