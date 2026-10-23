import { sandboxMode } from './policies.mjs';

// A host-side DSH plugin, loaded through an invocation-only overlay. No user profile edits.
export const inject = ['tools', 'agents', 'sandboxPolicy', 'approval'];
export function apply(ctx, config) {
  ctx.on('agent/created', ({ agent }) => {
    agent.session.append('sandbox/mode', { mode: sandboxMode(config.mode) });
    agent.session.append('approval/policy', { policy: 'never' });
    const writable = config.mode === 'workspace-write' || config.mode === 'full-access';
    const files = config.mode === 'communication' ? [] : ['read', 'read_image', 'glob', 'grep', ...(writable ? ['write', 'edit'] : []), ...(config.allowShell ? ['bash'] : [])];
    const available = [...config.tools, ...files].filter(name => agent.ctx.tools.get(name) !== undefined);
    const missing = config.tools.filter(name => !available.includes(name));
    if (missing.length) throw new Error(`团队沟通工具尚未加载，拒绝启动任务：${missing.join(', ')}`);
    agent.ctx.tools.restrict({ allow: available });
  });
}
