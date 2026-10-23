const modes = ['communication', 'read-only', 'workspace-write', 'full-access'];

export function executionPolicy(context) {
  const mode = context.policy?.mode ?? 'communication';
  if (!modes.includes(mode)) throw new Error('未知执行策略');
  const panelAccess = context.policy?.access ?? null;
  return {
    mode,
    allowShell: mode !== 'communication' && context.policy?.allowShell === true,
    ...(panelAccess ? { access: panelAccess } : {}),
  };
}

// Panel Agent 私人会话的 full-access 映射到宿主的无文件沙箱模式。
export function sandboxMode(mode) {
  if (mode === 'full-access' || mode === 'danger-full-access') return 'danger-full-access';
  if (mode === 'workspace-write') return 'workspace-write';
  return 'read-only';
}

export function codexPolicyConfig(policy, servers = []) {
  const disabled = ['apps', 'plugins', 'multi_agent', 'js_repl', 'code_mode', 'code_mode_host', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'view_image', 'skill_search', 'workspace_dependencies'];
  return { web_search: 'disabled', ...Object.fromEntries(disabled.map(k => [`features.${k}`, false])),
    'features.shell_tool': policy.allowShell, 'features.unified_exec': policy.allowShell,
    ...Object.fromEntries(servers.map(name => [`mcp_servers.${name}.enabled`, false])),
  };
}

export function claudeBuiltins(policy) {
  if (policy.mode === 'communication') return [];
  const files = policy.mode === 'read-only' ? [] : ['Edit', 'Write'];
  return ['Read', 'Glob', 'Grep', ...files, ...(policy.allowShell ? ['Bash'] : [])];
}

// Panel Agent 私人会话的 Claude 配置：Write/Edit 不受 Bash 沙箱约束，
// workspace-write 必须用权限路径规则把文件工具收在私人工作区内。
export function claudeExecutionConfig(policy, tools, workspace) {
  const panelAccess = policy.access ?? null;
  const builtins = claudeBuiltins(policy);
  const allowed = tools.map(tool => `mcp__agent_team__${tool.name}`);
  let sandbox = null;
  if (panelAccess === 'workspace-write') {
    allowed.push('Read', 'Glob', 'Grep', 'Bash', 'Edit(**)', 'Write(**)');
    sandbox = { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true };
  } else {
    allowed.push(...builtins);
    if (panelAccess !== 'full-access' && policy.allowShell) {
      sandbox = { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true, ...(policy.mode === 'read-only' ? { filesystem: { denyWrite: [workspace] } } : {}) };
    }
  }
  return { builtins, allowed, sandbox };
}

export function codexSandboxConfig(policy, workspace) {
  const sandbox = sandboxMode(policy.mode);
  const turnSandboxPolicy = policy.mode === 'full-access'
    ? { type: 'dangerFullAccess' }
    : policy.mode === 'workspace-write'
      ? { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
      : { type: 'readOnly', networkAccess: false };
  return { sandbox, turnSandboxPolicy };
}

export function policyObservation(host, policy, detail) {
  return { host, requested: policy, mechanism: detail, scope: '宿主工具和执行限制；非整进程绝对隔离', verified: 'configuration-applied', externalAccess: '文件策略不等于全部外部访问限制' };
}
