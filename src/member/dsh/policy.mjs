import { sandboxMode } from '../../hosts/policies.mjs';

// A host-side DSH plugin, loaded through an invocation-only overlay. No user profile edits.
export const inject = ['tools', 'agents', 'sandboxPolicy', 'approval'];
export function apply(ctx, config) {
  ctx.on('agent/created', ({ agent }) => {
    agent.session.append('sandbox/mode', { mode: sandboxMode(config.mode) });
    agent.session.append('approval/policy', { policy: 'never' });
    const writable = config.mode === 'workspace-write' || config.mode === 'full-access';
    const files = config.mode === 'communication' ? [] : ['read', 'read_image', 'glob', 'grep', ...(writable ? ['write', 'edit'] : []), ...(config.allowShell ? ['bash'] : [])];
    // 浏览器 MCP 由 headless profile 用户 patch 继承挂载；工具名只有启动后才可枚举（restrict 只接受精确名），
    // 这里按探测到的 server 前缀收齐工具再放行。探测有但未注册时拒绝启动，避免能力名片虚构。
    const browserTools = [];
    if (Array.isArray(config.browserServers) && config.browserServers.length) {
      const registered = new Set(agent.ctx.tools.definitions().map(definition => definition.name));
      const unmatched = [];
      for (const server of config.browserServers) {
        const prefix = typeof server?.toolPrefix === 'string' ? server.toolPrefix : '';
        const matched = prefix ? [...registered].filter(name => name.startsWith(prefix)) : [];
        if (!matched.length) { unmatched.push(server?.name ?? prefix ?? 'unknown'); continue; }
        browserTools.push(...matched);
      }
      if (unmatched.length) throw new Error(`浏览器 MCP 工具尚未加载，拒绝启动任务：${unmatched.join(', ')}`);
    }
    const available = [...new Set([...config.tools, ...browserTools, ...files])].filter(name => agent.ctx.tools.get(name) !== undefined);
    const missing = config.tools.filter(name => !available.includes(name));
    if (missing.length) throw new Error(`团队沟通工具尚未加载，拒绝启动任务：${missing.join(', ')}`);
    agent.ctx.tools.restrict({ allow: available });
  });
}
