import { roleNameKey } from './store/schema.mjs';
import * as turnsAgg from './aggregates/turns.mjs';

const now = () => new Date().toISOString();
const modes = ['communication', 'read-only', 'workspace-write'];
// 名称规范化键与 schema 种子共用一份实现；这里保持对外导出不变。
export { roleNameKey };
export function policyDomain(policy) {
  const mode = typeof policy === 'string' ? policy : policy?.mode;
  if (!modes.includes(mode)) throw new Error('未知执行策略');
  return mode === 'communication' ? 'communication' : 'project';
}

// Coordination responsibility lives with the agents and the user, expressed in
// ordinary messages. The framework only owns delivery safety: the archive
// switch, unverified runtimes, and unique member identity.
export class Collaboration {
  constructor(store) {
    this.store = store;
    this.policyValidator = () => ({ supported: true });
    // 模型策略/角色名称表与种子已收归 Store schema；这里只处理协作运行期职责。
    // A missing in-memory process is not proof that an interrupted owner's host stopped.
    // Serving the panel does not implicitly resume historical work.
    store.recoverInterruptedTurns();
  }
  communicationOpen(groupId) {
    return (this.store.group(groupId).state ?? 'open') === 'open';
  }
  requireCommunication(groupId) {
    if (!this.communicationOpen(groupId)) throw new Error('Team已归档，当前不接受消息');
    if (this.unknown(groupId).length) throw new Error('存在待核实的宿主运行，不能继续投递');
  }
  unknown(groupId) { return this.store.all("SELECT id AS turn_id,conversation_id AS endpoint_id,detail FROM turns WHERE group_id=? AND state='unknown' ORDER BY created", groupId); }
  reserveMemberName(groupId, memberId, name) {
    const key = roleNameKey(name);
    try {
      this.store.run('INSERT INTO role_names(group_id,name_key,member_id) VALUES(?,?,?)', groupId, key, memberId);
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed: role_names')) throw new Error(`角色名称已被本团队历史使用：${name.trim()}`, { cause: error });
      throw error;
    }
  }
  // Turn policy comes from the group configuration, not from a contract or
  // work items. Coordination and identity contexts always stay communication.
  policy(endpoint) {
    const group = this.store.group(endpoint.group_id);
    const communication = { mode: 'communication', allowShell: false, domain: 'communication' };
    if (['profile', 'private', 'coordination'].includes(endpoint.context)) return communication;
    const mode = modes.includes(group.policy) ? group.policy : 'workspace-write';
    const allowShell = mode !== 'communication' && (group.allow_shell ?? 1) === 1;
    return { mode, allowShell, domain: policyDomain(mode) };
  }
  resolveRuntime(groupId, turnId, reason) {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('需要说明核实依据');
    const changed = turnsAgg.resolveUnknownTurn(this.store, { groupId, turnId, detail: `用户核实：${reason.trim()}`, ended: now() });
    if (!changed.changes) throw new Error('待核实运行不存在');
  }
}
