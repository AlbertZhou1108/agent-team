export function executionPolicy(context) {
  const mode = context.policy?.mode ?? 'communication';
  if (!['communication', 'read-only', 'workspace-write'].includes(mode)) throw new Error('未知执行策略');
  return { mode, allowShell: mode !== 'communication' && context.policy?.allowShell === true };
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
  return ['Read', 'Glob', 'Grep', ...(policy.mode === 'workspace-write' ? ['Edit', 'Write'] : []), ...(policy.allowShell ? ['Bash'] : [])];
}

export function policyObservation(host, policy, detail) {
  return { host, requested: policy, mechanism: detail, scope: '宿主工具和执行限制；非整进程绝对隔离', verified: 'configuration-applied', externalAccess: '文件策略不等于全部外部访问限制' };
}
