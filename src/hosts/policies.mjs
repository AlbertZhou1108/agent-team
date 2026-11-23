const modes = ['communication', 'read-only', 'workspace-write', 'full-access'];

export function executionPolicy(context) {
  const mode = context.policy?.mode ?? 'communication';
  if (!modes.includes(mode)) throw new Error('未知执行策略');
  const panelAccess = context.policy?.access ?? null;
  return {
    mode,
    allowShell: mode !== 'communication' && context.policy?.allowShell === true,
    allowBrowser: mode !== 'communication' && context.policy?.allowBrowser === true,
    ...(panelAccess ? { access: panelAccess } : {}),
  };
}

// Panel Agent 私人会话的 full-access 映射到宿主的无文件沙箱模式。
export function sandboxMode(mode) {
  if (mode === 'full-access' || mode === 'danger-full-access') return 'danger-full-access';
  if (mode === 'workspace-write') return 'workspace-write';
  return 'read-only';
}

// 外置浏览器 MCP 的安全名称白名单：只按名字匹配，不按模型名或正文猜测。
const BROWSER_MCP_PATTERN = /(?:playwright|puppeteer|chrome[-_]?devtools|browser|computer[-_]?use)/i;

export function isBrowserMcpServer(name) {
  return typeof name === 'string' && BROWSER_MCP_PATTERN.test(name);
}

export function browserMcpServers(servers = []) {
  return (Array.isArray(servers) ? servers : []).filter(isBrowserMcpServer);
}

const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Claude Code --allowedTools 的 allow 规则：外置 MCP server 的全部工具用 mcp__<server>__* 放行。
 * 名字非法（会被 Claude 权限解析拒绝）时返回 null，宁可不放行也不生成无效规则。
 */
export function claudeMcpAllowRule(serverName) {
  if (typeof serverName !== 'string' || !MCP_SERVER_NAME.test(serverName)) return null;
  return `mcp__${serverName}__*`;
}

/** DSH mcp-client 的公开工具名前缀：mcp__<server>__；serverName 受限字符集，无需哈希后缀。 */
export function dshMcpToolPrefix(serverName) {
  if (typeof serverName !== 'string' || !MCP_SERVER_NAME.test(serverName)) return null;
  return `mcp__${serverName}__`;
}

export function codexPolicyConfig(policy, servers = []) {
  // allowBrowser 只解除浏览器/Computer Use/看图与浏览器 MCP 的禁用；其余高危特性保持关闭。
  const browserAllowed = policy.allowBrowser === true && policy.mode !== 'communication';
  const disabled = ['apps', 'plugins', 'multi_agent', 'js_repl', 'code_mode', 'code_mode_host', 'image_generation', 'skill_search', 'workspace_dependencies'];
  const browserFeatures = ['browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'view_image'];
  const names = Array.isArray(servers) ? servers : [];
  const browserServers = browserAllowed ? browserMcpServers(names) : [];
  const deniedServers = names.filter(name => !browserServers.includes(name));
  return { web_search: 'disabled',
    ...Object.fromEntries(disabled.map(k => [`features.${k}`, false])),
    ...Object.fromEntries(browserFeatures.map(k => [`features.${k}`, browserAllowed])),
    'features.shell_tool': policy.allowShell, 'features.unified_exec': policy.allowShell,
    ...Object.fromEntries(deniedServers.map(name => [`mcp_servers.${name}.enabled`, false])),
    ...Object.fromEntries(browserServers.map(name => [`mcp_servers.${name}.enabled`, true])),
  };
}

export function claudeBuiltins(policy) {
  if (policy.mode === 'communication') return [];
  const files = policy.mode === 'read-only' ? [] : ['Edit', 'Write'];
  return ['Read', 'Glob', 'Grep', ...files, ...(policy.allowShell ? ['Bash'] : [])];
}

// Panel Agent 私人会话的 Claude 配置：Write/Edit 不受 Bash 沙箱约束，
// workspace-write 必须用权限路径规则把文件工具收在私人工作区内。
export function claudeExecutionConfig(policy, tools, workspace, browserServers = [], extraWritableRoots = []) {
  const panelAccess = policy.access ?? null;
  const builtins = claudeBuiltins(policy);
  const allowed = tools.map(tool => `mcp__agent_team__${tool.name}`);
  // 外置浏览器 MCP：仅当本轮 allowBrowser 且启动配置真实挂载时才放行该 server 的全部工具。
  if (policy.allowBrowser === true && policy.mode !== 'communication') {
    for (const server of Array.isArray(browserServers) ? browserServers : []) {
      const rule = claudeMcpAllowRule(server?.name);
      if (rule && !allowed.includes(rule)) allowed.push(rule);
    }
  }
  const extraRoots = (Array.isArray(extraWritableRoots) ? extraWritableRoots : [])
    .filter(root => typeof root === 'string' && root && root !== workspace);
  let sandbox = null;
  if (panelAccess === 'workspace-write') {
    allowed.push('Read', 'Glob', 'Grep', 'Bash', 'Edit(**)', 'Write(**)');
    sandbox = { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true };
  } else {
    allowed.push(...builtins);
    if (panelAccess !== 'full-access' && policy.allowShell) {
      const filesystem = policy.mode === 'read-only'
        ? { denyWrite: [workspace] }
        : extraRoots.length
          ? { allowWrite: extraRoots }
          : null;
      sandbox = { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true, ...(filesystem ? { filesystem } : {}) };
    }
  }
  return { builtins, allowed, sandbox };
}

export function codexSandboxConfig(policy, workspace, extraWritableRoots = []) {
  const sandbox = sandboxMode(policy.mode);
  const extraRoots = (Array.isArray(extraWritableRoots) ? extraWritableRoots : [])
    .filter(root => typeof root === 'string' && root && root !== workspace);
  const turnSandboxPolicy = policy.mode === 'full-access'
    ? { type: 'dangerFullAccess' }
    : policy.mode === 'workspace-write'
      ? { type: 'workspaceWrite', writableRoots: [workspace, ...extraRoots], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
      : { type: 'readOnly', networkAccess: false };
  return { sandbox, turnSandboxPolicy };
}

export function policyObservation(host, policy, detail) {
  return { host, requested: policy, mechanism: detail, scope: '宿主工具和执行限制；非整进程绝对隔离', verified: 'configuration-applied', externalAccess: '文件策略不等于全部外部访问限制' };
}

// 附件只服务于 Panel 私人会话;communication 投递路径不接收附件输入,也不因此扩大权限。
export function panelAttachmentsAllowed(policy) {
  return Boolean(policy?.access);
}

// 附件内部文件清单:只出现在宿主调用输入中,绝不写回用户可见正文或浏览器消息。
export function attachmentManifest(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return '';
  return list.map(item => `[attachment:${item.id}] ${item.mediaType} ${item.name} -> ${item.path}`).join('\n');
}
