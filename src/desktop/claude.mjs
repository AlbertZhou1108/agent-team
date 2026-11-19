// Claude Desktop 垂直切片:claude_desktop_config.json 受管条目安装与验证策略。
// 实测事实(交接文档):桌面 MCP 子进程拿不到 CLAUDE_SESSION_ID,也没有安全的
// 同会话唤醒路径——Claude 桌面集成解析为应用级单连接并保持 Pull-only;
// 内嵌引擎由应用按版本下载到 ~/Library/Application Support/Claude-3p/claude-code。
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createExternalIdentity } from '../control-plane.mjs';
import { nodeRunner } from '../runtime.mjs';
import { disableBinding } from '../aggregates/external-control.mjs';

const CONTROL_MCP_NAME = 'agent_team';

/**
 * 安装 Claude Desktop 集成:claude_desktop_config.json 的 mcpServers.agent_team
 * 键归 Agent Team 所有,其余键原样保留;写入前哈希备份。
 * 声明能力刻意不含 session.wake——没有已验证的同会话唤醒,应用级连接保持 Pull-only。
 */
export async function installClaudeDesktopIntegration(store, {
  principalName = '本机用户',
  detections,
  claudeConfigDir = join(homedir(), 'Library', 'Application Support', 'Claude'),
  socketPath,
  runner = nodeRunner(),
  cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url)),
  now = new Date().toISOString(),
} = {}) {
  if (!socketPath) throw new Error('桌面接入安装需要总线 socket 路径');
  const detected = detections?.find?.(item => item.kind === 'claude' && item.found);
  if (!detected) throw new Error('未检测到 Claude Desktop 安装;请先安装桌面应用再接入');

  const identity = createExternalIdentity(store, {
    principalName,
    bindingName: 'Claude Desktop 接入',
    host: 'claude',
    session: null,
    declared: {
      // 无 session.wake:Pull-only 是产品模式而非半成品(ADR 0011)。
      capabilities: ['session.deliver', 'turn.observe', 'user.elicit', 'user.notify'],
      workspaceRoots: [homedir()],
      policies: ['communication', 'read-only', 'workspace-write'],
    },
    surface: 'desktop',
    appId: detected.applicationId,
    bindingKind: 'activation',
  });

  const configPath = join(claudeConfigDir, 'claude_desktop_config.json');
  mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  let parsed = {};
  if (configText.trim()) {
    try {
      parsed = JSON.parse(configText);
    } catch {
      throw new Error('claude_desktop_config.json 不是合法 JSON;请手动修复后重试');
    }
  }
  parsed.mcpServers ??= {};
  const replacedUserEntry = Boolean(parsed.mcpServers[CONTROL_MCP_NAME]);
  parsed.mcpServers[CONTROL_MCP_NAME] = {
    command: runner.command,
    args: ['--disable-warning=ExperimentalWarning', cliPath, 'mcp', '--socket', socketPath, '--client', identity.binding.id],
    env: { AGENT_TEAM_CLIENT_KEY: identity.key, AGENT_TEAM_CONTROL_PROTOCOL: '1' },
  };
  let backupPath = null;
  let backupHash = null;
  if (configText) {
    backupPath = `${configPath}.agent-team-backup-${now.replace(/[:.]/g, '-')}`;
    copyFileSync(configPath, backupPath);
    chmodSync(backupPath, 0o600);
    backupHash = createHash('sha256').update(configText).digest('hex');
  }
  writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  return {
    applicationId: detected.applicationId,
    binding: {
      id: identity.binding.id,
      name: identity.binding.name,
      bindingKind: 'activation',
      surface: 'desktop',
      host: identity.binding.host,
    },
    configPath,
    socketPath,
    backupPath,
    backupHash,
    replacedUserEntry,
    enginePath: detected.enginePath,
    engineVersion: detected.engineVersion,
    limitations: [
      '桌面会话没有会话身份通道:整个 Claude Desktop 解析为一条应用级主控连接,多会话隔离暂不可用。',
      '没有已验证的同会话唤醒:该应用保持 Pull-only(可用,仅手动查看消息)。',
    ],
    nextStep: '重启 Claude Desktop 加载 MCP 连接器;在桌面会话内调用 Agent Team Skill 即接入(应用级连接,保持仅拉取)。',
  };
}

// --- 验证策略(真实运行消耗模型额度;由额度确认门保护) -----------------------

const CONTROLLER_CHECK_PROMPT = '你是 Agent Team 桌面接入验证会话。调用一次 control_protocol 工具,把返回 JSON 里的 version 数字原样写在最终回复里,不要做其他事情。';
const ENGINE_CHECK_PROMPT = '只回复两个字符:OK';

function runEngineTurn({ enginePath, workspace, spawnTracked, timeoutMs, args, env = {} }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('验证回合超时')), timeoutMs);
    const child = spawnTracked(enginePath, args, { cwd: workspace, env: { ...process.env, ...env } });
    let output = '';
    child.stdout?.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`内嵌引擎退出 (${code})`));
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`无法启动内嵌引擎: ${error.message}`));
    });
  });
}

export function claudeDesktopVerification() {
  return {
    async verifyEngine({ workspace, detection, spawnTracked, timeoutMs }) {
      const output = await runEngineTurn({
        enginePath: detection.enginePath,
        workspace,
        spawnTracked,
        timeoutMs,
        args: ['-p', ENGINE_CHECK_PROMPT],
      });
      return { ok: /ok/i.test(output), detail: '内嵌引擎完成短任务' };
    },
    async verifyController({ store, workspace, detection, spawnTracked, socketPath, timeoutMs }) {
      if (!socketPath) return { ok: false, reason: '总线 socket 不可用,无法配置验证 MCP' };
      const temp = createExternalIdentity(store, {
        principalName: 'Agent Team 验证',
        bindingName: `claude-desktop-verify-${randomUUID().slice(0, 8)}`,
        host: 'claude',
        declared: {
          capabilities: ['session.deliver', 'turn.observe'],
          workspaceRoots: [homedir()],
          policies: ['read-only'],
        },
        surface: 'desktop',
      });
      try {
        const mcpConfigFile = join(workspace, `agent-team-verify-${randomUUID().slice(0, 8)}.json`);
        writeFileSync(mcpConfigFile, JSON.stringify({
          mcpServers: {
            agent_team: {
              command: nodeRunner().command,
              args: ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'mcp', '--socket', socketPath, '--client', temp.binding.id],
              env: { AGENT_TEAM_CLIENT_KEY: temp.key, AGENT_TEAM_CONTROL_PROTOCOL: '1' },
            },
          },
        }), { mode: 0o600 });
        try {
          const output = await runEngineTurn({
            enginePath: detection.enginePath,
            workspace,
            spawnTracked,
            timeoutMs,
            args: ['-p', '--strict-mcp-config', '--mcp-config', mcpConfigFile, '--permission-mode', 'dontAsk', CONTROLLER_CHECK_PROMPT],
          });
          return { ok: /version|1/.test(output), detail: '主控工具可调用' };
        } finally {
          rmSync(mcpConfigFile, { force: true, maxRetries: 3, retryDelay: 50 });
        }
      } finally {
        disableBinding(store, temp.binding.id);
      }
    },
  };
}
