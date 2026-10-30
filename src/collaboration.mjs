import { DEFAULT_USER_MODEL_RULES } from './model-policy.mjs';

const now = () => new Date().toISOString();
const modes = ['communication', 'read-only', 'workspace-write'];
export function roleNameKey(name) {
  return name.normalize('NFKC').trim().toLowerCase();
}
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
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS global_model_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_model_policy(group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_attempts(turn_id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,endpoint_id TEXT NOT NULL,state TEXT NOT NULL,policy TEXT NOT NULL,detail TEXT,created TEXT NOT NULL,ended TEXT);
      CREATE INDEX IF NOT EXISTS runtime_group ON runtime_attempts(group_id,state);
      CREATE TABLE IF NOT EXISTS endpoint_policy(endpoint_id TEXT PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS endpoint_session_bindings(endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session_key TEXT NOT NULL,session TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(endpoint_id,session_key));
      CREATE TABLE IF NOT EXISTS endpoint_session_policies(endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session_key TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(endpoint_id,session_key));
      CREATE TABLE IF NOT EXISTS role_names(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,name_key TEXT NOT NULL,member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,PRIMARY KEY(group_id,name_key));
    `);
    // 激活策略记录来源配置 id:内容相同的多份配置也能区分。
    if (!store.all('PRAGMA table_info(global_model_policy)').some(column => column.name === 'preset_id')) {
      store.db.exec('ALTER TABLE global_model_policy ADD COLUMN preset_id TEXT');
    }
    if (!store.get('SELECT 1 FROM global_model_policy WHERE singleton=1')) {
      const legacy = store.get('SELECT mode,rules,created,updated FROM team_model_policy ORDER BY updated DESC LIMIT 1');
      store.run(
        'INSERT INTO global_model_policy(singleton,mode,rules,created,updated) VALUES(1,?,?,?,?)',
        legacy?.mode ?? 'user',
        legacy?.rules ?? DEFAULT_USER_MODEL_RULES,
        legacy?.created ?? now(),
        legacy?.updated ?? now(),
      );
    }
    for (const member of store.all('SELECT id,group_id,name FROM members ORDER BY rowid')) {
      const key = roleNameKey(member.name);
      const prior = store.get('SELECT member_id FROM role_names WHERE group_id=? AND name_key=?', member.group_id, key);
      if (prior && prior.member_id !== member.id) throw new Error('历史成员名称规范化后重复，无法安全迁移角色名称');
      store.run('INSERT OR IGNORE INTO role_names(group_id,name_key,member_id) VALUES(?,?,?)', member.group_id, key, member.id);
    }
    // A missing in-memory process is not proof that an interrupted owner's host stopped.
    store.run("UPDATE runtime_attempts SET state='unknown',detail='总线重启，需要用户核实宿主是否已停止' WHERE state='running'");
  }
  communicationOpen(groupId) {
    return (this.store.group(groupId).state ?? 'open') === 'open';
  }
  requireCommunication(groupId) {
    if (!this.communicationOpen(groupId)) throw new Error('Team已归档，当前不接受消息');
    if (this.unknown(groupId).length) throw new Error('存在待核实的宿主运行，不能继续投递');
  }
  unknown(groupId) { return this.store.all("SELECT turn_id,endpoint_id,detail FROM runtime_attempts WHERE group_id=? AND state='unknown'", groupId); }
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
    const changed = this.store.run("UPDATE runtime_attempts SET state='stopped',detail=?,ended=? WHERE group_id=? AND turn_id=? AND state='unknown'", `用户核实：${reason.trim()}`, now(), groupId, turnId);
    if (!changed.changes) throw new Error('待核实运行不存在');
  }
}
