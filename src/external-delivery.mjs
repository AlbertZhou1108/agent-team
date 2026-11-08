import { runCommand } from './hosts/lifecycle.mjs';

function wakeText({ teamName, count }) {
  return [
    '[Agent Team]',
    `团队「${teamName}」有 ${count} 条待处理事件。`,
    '请调用 control_inbox 领取。收件箱领取只表示输入已被客户端接受，不代表任务已完成。',
  ].join('\n');
}

function tomlTable(value) {
  return `{ ${Object.entries(value).map(([key, item]) => `${key} = ${JSON.stringify(item)}`).join(', ')} }`;
}

/**
 * 主动唤醒与控制工具的“领取”分离：
 * - wake 只负责让宿主现有会话开始一个回合；
 * - 事件仍保持 pending，直到 control_inbox 真正领取。
 */
export function externalWakePlan(binding, { teamName, count }) {
  if (!binding || binding.status !== 'active') {
    return { supported: false, reason: 'active controller binding 不存在或已禁用' };
  }
  if (!binding.session) {
    return { supported: false, reason: '尚未发现宿主 session；请在宿主会话内调用 control_protocol 完成绑定' };
  }
  if (binding.host !== 'codex') {
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
    command,
    timeoutMs: 8 * 60 * 1000,
    args: [
      'exec', 'resume', binding.session,
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-c', 'sandbox_mode="read-only"',
      '-c', `mcp_servers.agent_team.command=${JSON.stringify(wakeConfig.command)}`,
      '-c', `mcp_servers.agent_team.args=${JSON.stringify(wakeConfig.args)}`,
      '-c', `mcp_servers.agent_team.env=${tomlTable(wakeConfig.env ?? {})}`,
      '-c', 'mcp_servers.agent_team.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.agent_team.startup_timeout_sec=120',
      wakeText({ teamName, count }),
    ],
  };
}

export async function deliverExternalWake(binding, options, { run = runCommand } = {}) {
  const plan = externalWakePlan(binding, options);
  if (!plan.supported) return plan;
  await run(plan.command, plan.args, plan.timeoutMs);
  return plan;
}
