import { nodeRunner } from '../runtime.mjs';

export const CONTROL_MCP_NAME = 'agent_team';

/**
 * 桌面宿主的 MCP 启动规格:三家引擎共用同一份命令、参数与环境,
 * 各家只负责把它序列化成自己的配置格式(TOML / JSON / Profile 条目)。
 */
export function desktopControlMcpSpec({ socketPath, bindingId, clientKey, runner = nodeRunner(), cliPath }) {
  return {
    command: runner.command,
    args: ['--disable-warning=ExperimentalWarning', cliPath, 'mcp', '--socket', socketPath, '--client', bindingId],
    env: { AGENT_TEAM_CLIENT_KEY: clientKey, AGENT_TEAM_CONTROL_PROTOCOL: '1' },
  };
}
