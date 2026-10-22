import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { DEFAULT_USER_MODEL_RULES } from './model-policy.mjs';

const now = () => new Date().toISOString();
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const modes = ['communication', 'read-only', 'workspace-write'];
export function roleNameKey(name) {
  return name.normalize('NFKC').trim().toLowerCase();
}
export function policyDomain(policy) {
  const mode = typeof policy === 'string' ? policy : policy?.mode;
  if (!modes.includes(mode)) throw new Error('未知执行策略');
  return mode === 'communication' ? 'communication' : 'project';
}
function narrower(a, b) {
  return modes[Math.min(modes.indexOf(a), modes.indexOf(b))];
}
const transitions = {
  pending: ['in_progress', 'cancelled'], in_progress: ['blocked', 'pending_decision', 'cancelled'],
  blocked: ['in_progress', 'cancelled'], pending_decision: ['in_progress', 'accepted', 'cancelled'],
  accepted: ['in_progress'], cancelled: [],
};
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 48000) throw new Error(`${name}需要非空文本`);
  return value.trim();
}
export function validateContract(input) {
  const c = typeof input === 'string' ? parse(input) : input;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('契约格式无效');
  const result = Object.fromEntries(['goal', 'scope', 'boundary', 'confirmation', 'delivery'].map(k => [k, text(c[k], k)]));
  if (!modes.includes(c.policy)) throw new Error('契约policy无效');
  if (!Array.isArray(c.criteria) || !c.criteria.length || c.criteria.length > 100) throw new Error('需要1至100项完成条件');
  result.policy = c.policy;
  if (c.allowShell !== undefined && typeof c.allowShell !== 'boolean') throw new Error('allowShell必须是布尔值');
  result.allowShell = c.policy !== 'communication' && c.allowShell === true;
  result.criteria = c.criteria.map((item, i) => ({ id: `c${i + 1}`, text: text(typeof item === 'string' ? item : item.text, '完成条件') }));
  return result;
}

export class Collaboration {
  constructor(store) {
    this.store = store;
    this.policyValidator = () => ({ supported: true });
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS preparations(id TEXT PRIMARY KEY,spec TEXT NOT NULL,contract TEXT,revision INTEGER NOT NULL DEFAULT 0,hash TEXT,session TEXT,key TEXT NOT NULL,group_id TEXT,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS global_model_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_model_policy(group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contract_versions(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,version INTEGER NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,approval TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(group_id,version));
      CREATE TABLE IF NOT EXISTS team_state(group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 1,goal_version INTEGER NOT NULL DEFAULT 1,contract_version INTEGER NOT NULL DEFAULT 1,phase TEXT NOT NULL DEFAULT 'active',outcome TEXT,final TEXT,finish_reason TEXT);
      CREATE TABLE IF NOT EXISTS work_items(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,goal_version INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_records(seq INTEGER PRIMARY KEY AUTOINCREMENT,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,goal_version INTEGER NOT NULL DEFAULT 1,work_item_id TEXT,type TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS change_requests(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,base_version INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_operations(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(group_id,id));
      CREATE TABLE IF NOT EXISTS message_context(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,work_item_id TEXT,contract_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS message_dispositions(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,state TEXT NOT NULL,reason TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_attempts(turn_id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,endpoint_id TEXT NOT NULL,state TEXT NOT NULL,policy TEXT NOT NULL,contract_version INTEGER NOT NULL,detail TEXT,created TEXT NOT NULL,ended TEXT);
      CREATE TABLE IF NOT EXISTS user_outputs(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,goal_version INTEGER NOT NULL DEFAULT 1,body TEXT NOT NULL,created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS work_records_group ON work_records(group_id,seq);
      CREATE INDEX IF NOT EXISTS runtime_group ON runtime_attempts(group_id,state);
      CREATE TABLE IF NOT EXISTS endpoint_policy(endpoint_id TEXT PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS endpoint_session_bindings(endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session_key TEXT NOT NULL,session TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(endpoint_id,session_key));
      CREATE TABLE IF NOT EXISTS endpoint_session_policies(endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session_key TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(endpoint_id,session_key));
      CREATE TABLE IF NOT EXISTS preparation_policy(preparation_id TEXT PRIMARY KEY REFERENCES preparations(id) ON DELETE CASCADE,signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS role_names(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,name_key TEXT NOT NULL,member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,PRIMARY KEY(group_id,name_key));
    `);
    const ensureColumn = (table, name, definition) => {
      if (!store.all(`PRAGMA table_info(${table})`).some(column => column.name === name)) {
        store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    for (const table of ['team_state', 'work_items', 'work_records', 'user_outputs']) ensureColumn(table, 'goal_version', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn('preparations', 'model_provider', 'TEXT');
    ensureColumn('preparations', 'model', 'TEXT');
    ensureColumn('preparations', 'reasoning_effort', 'TEXT');
    ensureColumn('preparations', 'role_plan', 'TEXT');
    ensureColumn('members', 'joined_goal_version', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn('members', 'removed_goal_version', 'INTEGER');
    if (!store.get('SELECT 1 FROM global_model_policy WHERE singleton=1')) {
      const legacy = store.get('SELECT mode,rules,created,updated FROM team_model_policy ORDER BY updated DESC LIMIT 1');
      store.run(
        'INSERT INTO global_model_policy VALUES(1,?,?,?,?)',
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
  prepare(spec) {
    const id = randomUUID();
    this.store.run('INSERT INTO preparations(id,spec,key,created) VALUES(?,?,?,?)', id, json(spec), randomBytes(32).toString('hex'), now());
    return this.preparation(id);
  }
  preparation(id) {
    const row = this.store.get('SELECT * FROM preparations WHERE id=?', id);
    if (!row) throw new Error('准备记录不存在');
    return {
      id: row.id,
      spec: parse(row.spec),
      contract: row.contract ? parse(row.contract) : null,
      revision: row.revision,
      hash: row.hash,
      groupId: row.group_id,
      created: row.created,
      sessionModel: row.model
        ? { model_provider: row.model_provider ?? null, model: row.model, reasoning_effort: row.reasoning_effort ?? null }
        : null,
      rolePlan: row.role_plan ? parse(row.role_plan) : null,
    };
  }
  updateSessionModel(id, selection) {
    const p = this.preparation(id);
    if (p.groupId) throw new Error('准备会话已经建群');
    if (!selection?.model) throw new Error('会话模型选择缺少model');
    this.store.run(
      'UPDATE preparations SET model_provider=?,model=?,reasoning_effort=? WHERE id=?',
      selection.model_provider ?? null,
      selection.model,
      selection.reasoning_effort ?? null,
      id,
    );
    return this.preparation(id);
  }
  setRolePlan(id, revision, roles, validate) {
    const p = this.preparation(id);
    if (p.groupId) throw new Error('准备会话已经建群');
    if (p.revision !== revision) throw new Error('准备记录版本冲突，请重新读取');
    const plan = { roles: validate(roles, p.spec) };
    this.store.run('UPDATE preparations SET role_plan=? WHERE id=?', json(plan), id);
    return this.preparation(id);
  }
  propose(id, contract, revision) {
    const p = this.preparation(id);
    if (p.groupId) throw new Error('已建群，契约修改需要用户批准新版本');
    if (p.revision !== revision) throw new Error('准备记录版本冲突，请重新读取');
    const body = validateContract(contract);
    this.store.run('UPDATE preparations SET contract=?,revision=revision+1,hash=? WHERE id=?', json(body), digest({ spec: p.spec, contract: body }), id);
    return this.preparation(id);
  }
  confirmPreparation(id, revision, hash, create) {
    const result = this.store.transaction(() => {
      const p = this.preparation(id);
      if (p.revision !== revision || p.hash !== hash || !p.contract) throw new Error('确认与当前契约不匹配');
      if (p.groupId) return this.store.group(p.groupId);
      const group = create(p.spec);
      this.store.run('INSERT INTO contract_versions VALUES(?,?,?,?,?,?)', group.id, 1, json(p.contract), hash, json({ preparationId: id, revision, source: 'local-user' }), now());
      this.store.run('INSERT INTO team_state(group_id) VALUES(?)', group.id);
      this.store.run('UPDATE preparations SET group_id=? WHERE id=?', group.id, id);
      return group;
    });
    return result;
  }
  state(groupId) { return this.store.get('SELECT * FROM team_state WHERE group_id=?', groupId); }
  communicationOpen(groupId) {
    if ((this.store.group(groupId).state ?? 'open') !== 'open') return false;
    const s = this.state(groupId);
    return s?.phase === 'active' || s?.phase === 'closed';
  }
  communicationOnly(groupId) {
    const s = this.state(groupId);
    return s?.phase === 'closed';
  }
  requireActive(groupId) {
    const s = this.state(groupId);
    if (!s) throw new Error('旧群尚未确认目标契约，仅供查看');
    if (s.phase !== 'active') throw new Error(`团队处于${s.phase}，不能派发工作`);
    if (this.unknown(groupId).length) throw new Error('存在待核实的宿主运行，不能继续派发');
    return s;
  }
  requireCommunication(groupId) {
    const s = this.state(groupId);
    if (!s) throw new Error('旧群尚未确认目标契约，仅供查看');
    if ((this.store.group(groupId).state ?? 'open') !== 'open') {
      throw new Error('Team已归档，当前不接受消息');
    }
    if (!this.communicationOpen(groupId)) throw new Error(`团队处于${s.phase}，当前不接受消息`);
    if (this.unknown(groupId).length) throw new Error('存在待核实的宿主运行，不能继续投递');
    return s;
  }
  requireNextGoal(groupId) {
    const s = this.state(groupId);
    if (!s) throw new Error('旧群尚未确认目标契约，仅供查看');
    if (s.phase !== 'closed' || !['completed', 'incomplete'].includes(s.outcome)) throw new Error('只有已经结束的当前目标可以启动下一版目标');
    if (this.unknown(groupId).length) throw new Error('存在待核实的宿主运行，不能启动下一版目标');
    return s;
  }
  reserveMemberName(groupId, memberId, name) {
    const key = roleNameKey(name);
    try {
      this.store.run('INSERT INTO role_names(group_id,name_key,member_id) VALUES(?,?,?)', groupId, key, memberId);
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed: role_names')) throw new Error(`角色名称已被本团队历史使用：${name.trim()}`);
      throw error;
    }
  }
  contract(groupId) {
    const s = this.state(groupId);
    if (!s) return null;
    const row = this.store.get('SELECT * FROM contract_versions WHERE group_id=? AND version=?', groupId, s.contract_version);
    return { version: row.version, body: parse(row.body), hash: row.hash, created: row.created };
  }
  unknown(groupId) { return this.store.all("SELECT turn_id,endpoint_id,detail FROM runtime_attempts WHERE group_id=? AND state='unknown'", groupId); }
  item(id, groupId) {
    const r = this.store.get('SELECT * FROM work_items WHERE id=? AND group_id=?', id, groupId);
    if (!r) throw new Error('工作项不属于当前群');
    return { id: r.id, goalVersion: r.goal_version, revision: r.revision, state: r.state, ...parse(r.body) };
  }
  currentItems(groupId, state = this.state(groupId)) {
    return this.store.all('SELECT id FROM work_items WHERE group_id=? AND goal_version=? ORDER BY rowid', groupId, state.goal_version)
      .map(row => this.item(row.id, groupId));
  }
  read(groupId, after = 0) {
    this.store.group(groupId);
    const s = this.state(groupId);
    if (!s) return { legacy: true, contract: null, state: null, communicationOpen: false, items: [], requests: [], records: [], unknown: [] };
    const records = this.store.all('SELECT * FROM work_records WHERE group_id=? AND seq>? ORDER BY seq LIMIT 100', groupId, after).map(r => ({ ...r, body: parse(r.body) }));
    return { legacy: false, contract: this.contract(groupId), state: s, communicationOpen: this.communicationOpen(groupId),
      items: this.store.all('SELECT id FROM work_items WHERE group_id=? ORDER BY rowid', groupId).map(r => this.item(r.id, groupId)),
      requests: this.store.all("SELECT id,base_version,kind,body,state,created FROM change_requests WHERE group_id=? ORDER BY rowid", groupId).map(r => ({ ...r, body: parse(r.body) })),
      records, nextAfter: records.at(-1)?.seq ?? after, unknown: this.unknown(groupId),
      pendingMessages: this.pending(groupId),
      runningCount: this.store.get("SELECT COUNT(*) AS n FROM runtime_attempts WHERE group_id=? AND state='running'", groupId).n,
      outputs: this.store.all('SELECT id,goal_version,body,created FROM user_outputs WHERE group_id=? ORDER BY rowid', groupId)
        .map(row => ({ id: row.id, goalVersion: row.goal_version, body: row.body, created: row.created })),
    };
  }
  record(groupId, itemId, type, body) {
    const goalVersion = this.state(groupId)?.goal_version ?? 1;
    this.store.run(
      'INSERT INTO work_records(group_id,goal_version,work_item_id,type,body,created,goal_id) VALUES(?,?,?,?,?,?,?)',
      groupId,
      goalVersion,
      itemId,
      type,
      json(body),
      now(),
      this.currentGoalId(groupId),
    );
  }
  messageContext(groupId, itemId) {
    const s = this.requireCommunication(groupId);
    if (itemId && this.communicationOnly(groupId)) throw new Error('目标已经结束，后续沟通不能关联旧工作项');
    if (itemId && this.item(itemId, groupId).goalVersion !== s.goal_version) throw new Error('工作项不属于当前目标');
    return { workItemId: itemId ?? null, contractVersion: s.contract_version, goalId: this.currentGoalId(groupId) };
  }
  currentGoalId(groupId) {
    const state = this.state(groupId);
    if (!state || !['active', 'closing'].includes(state.phase)) return null;
    return this.goalIdForVersion(groupId, state.goal_version);
  }
  goalIdForVersion(groupId, goalVersion) {
    if (!this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goals'")) return null;
    return this.store.get(
      'SELECT id FROM goals WHERE group_id=? AND number=?',
      groupId,
      goalVersion,
    )?.id ?? null;
  }
  adoptGoal(groupId, goal) {
    const state = this.state(groupId);
    if (!state || !goal?.contract?.contract) throw new Error('Goal缺少可投影契约');
    if (state.phase === 'active' && state.goal_version === goal.number) return state;
    const version = state.contract_version + 1;
    this.store.transaction(() => {
      this.store.run(
        'INSERT INTO contract_versions VALUES(?,?,?,?,?,?)',
        groupId,
        version,
        json(goal.contract.contract),
        goal.contractHash ?? digest(goal.contract.contract),
        json({ source: 'goal-lifecycle', goalId: goal.id, goalNumber: goal.number }),
        now(),
      );
      this.store.run(
        `UPDATE team_state
         SET goal_version=?,contract_version=?,phase='active',outcome=NULL,final=NULL,
             finish_reason=NULL,revision=revision+1
         WHERE group_id=?`,
        goal.number,
        version,
        groupId,
      );
      this.record(groupId, null, 'goal_activated', { goalId: goal.id, goalNumber: goal.number });
    });
    return this.state(groupId);
  }
  projectClosedGoal(groupId, goal) {
    const state = this.state(groupId);
    if (!state || state.goal_version !== goal?.number) return state;
    this.store.run(
      `UPDATE team_state
       SET phase='closed',outcome=?,final=?,finish_reason=?,revision=revision+1
       WHERE group_id=?`,
      goal.outcome ?? (goal.state === 'completed' ? 'completed' : 'incomplete'),
      goal.final ?? null,
      goal.finishReason ?? null,
      groupId,
    );
    return this.state(groupId);
  }
  policy(endpoint, inputs = []) {
    const contract = this.contract(endpoint.group_id);
    if (!contract) throw new Error('缺少已确认契约');
    const state = this.state(endpoint.group_id);
    if (this.communicationOnly(endpoint.group_id)) {
      return {
        mode: 'communication',
        allowShell: false,
        domain: 'communication',
        contractVersion: contract.version,
        boundary: contract.body.boundary,
        goalCompleted: state.outcome === 'completed',
        goalOutcome: state.outcome,
      };
    }
    const effective = message => {
      const context = this.store.get('SELECT work_item_id FROM message_context WHERE message_id=?', message.id);
      if (!context?.work_item_id) return { mode: 'communication', allowShell: false };
      const item = this.item(context.work_item_id, endpoint.group_id);
      const participant = item.participants?.find(person => person.memberId === endpoint.member_id);
      if (!participant) return { mode: 'communication', allowShell: false };
      const mode = participant.role === 'reviewer' ? narrower(item.policy, 'read-only') : item.policy;
      return { mode, allowShell: mode !== 'communication' && item.allowShell === true && contract.body.allowShell === true };
    };
    if (endpoint.context === 'profile' || endpoint.context === 'private') {
      return { mode: 'communication', allowShell: false, domain: 'communication', contractVersion: contract.version, boundary: contract.body.boundary };
    }
    const policies = inputs.filter(message => message.kind === 'send').map(effective);
    if (!policies.length) policies.push({ mode: 'communication', allowShell: false });
    const signatures = [...new Set(policies.map(item => `${item.mode}:${item.allowShell}`))];
    if (signatures.length > 1) throw new Error('不同执行策略不能合并到同一回合');
    const selected = policies[0];
    if (modes.indexOf(selected.mode) > modes.indexOf(contract.body.policy)) throw new Error('工作项权限超过当前契约，需要重新安排');
    return { ...selected, domain: policyDomain(selected.mode), contractVersion: contract.version, boundary: contract.body.boundary };
  }
  apply(actor, command, revision, operationId) {
    if (actor.role !== 'lead' || actor.context !== 'coordination') throw new Error('仅主 Agent调度会话可管理工作状态');
    text(operationId, 'operationId');
    const groupId = actor.group_id;
    const hash = digest(command);
    return this.store.transaction(() => {
      const prior = this.store.get('SELECT * FROM collaboration_operations WHERE group_id=? AND id=?', groupId, operationId);
      if (prior) { if (prior.hash !== hash) throw new Error('同一operationId不能用于不同命令'); return parse(prior.result); }
      const s = this.requireActive(groupId);
      if (s.revision !== revision) throw new Error(`执行状态版本冲突，当前revision=${s.revision}，请重新读取`);
      const result = command.action === 'finish' ? this.finish(groupId, command) : this.updateItem(groupId, command);
      this.store.run('UPDATE team_state SET revision=revision+1 WHERE group_id=?', groupId);
      const out = { ...result, revision: s.revision + 1 };
      this.store.run('INSERT INTO collaboration_operations VALUES(?,?,?,?)', groupId, operationId, hash, json(out));
      return out;
    });
  }
  updateItem(groupId, c) {
    const goalState = this.requireActive(groupId);
    const creating = !c.id;
    const previous = creating ? null : this.item(c.id, groupId);
    if (previous && previous.goalVersion !== goalState.goal_version) throw new Error('工作项属于先前的目标，不能修改');
    if (!creating && c.itemRevision !== previous.revision) throw new Error('工作项版本冲突');
    const id = c.id ?? randomUUID();
    const state = c.state ?? previous?.state ?? 'pending';
    if (!transitions[state]) throw new Error('工作项状态无效');
    if (creating && state !== 'pending') throw new Error('新工作项须从pending开始');
    if (previous && state !== previous.state && !transitions[previous.state].includes(state)) throw new Error('工作项状态流转无效');
    const body = { title: c.title ?? previous?.title, purpose: c.purpose ?? previous?.purpose, standard: c.standard ?? previous?.standard,
      participants: c.participants ?? previous?.participants, policy: c.policy ?? previous?.policy ?? 'communication',
      allowShell: c.allowShell ?? previous?.allowShell ?? false,
      reviewRequired: c.reviewRequired ?? previous?.reviewRequired ?? false, artifact: c.artifact ?? previous?.artifact ?? null,
      evidence: c.evidence ?? previous?.evidence ?? [], reviews: c.reviews ?? previous?.reviews ?? [] };
    for (const k of ['title', 'purpose', 'standard']) text(body[k], k);
    if (!modes.includes(body.policy) || modes.indexOf(body.policy) > modes.indexOf(this.contract(groupId).body.policy)) throw new Error('工作项策略超出契约');
    if (typeof body.allowShell !== 'boolean' || (body.allowShell && (body.policy === 'communication' || !this.contract(groupId).body.allowShell))) throw new Error('工作项命令权限无效');
    if (typeof body.reviewRequired !== 'boolean' || !Array.isArray(body.participants) || !body.participants.length) throw new Error('需要参与成员与明确审查要求');
    const seen = new Set();
    for (const p of body.participants) {
      const m = this.store.member(p.memberId);
      if (m.group_id !== groupId || !['executor', 'collaborator', 'reviewer'].includes(p.role) || seen.has(m.id)) throw new Error('参与成员或职责无效');
      const mode = p.role === 'reviewer' ? narrower(body.policy, 'read-only') : body.policy;
      const effective = { mode, allowShell: mode !== 'communication' && body.allowShell === true };
      const support = this.policyValidator(m, effective) ?? { supported: true };
      if (support === false || support.supported === false) throw new Error(`${m.name}（${m.host}）不支持${mode}${effective.allowShell ? ' + 命令' : ''}：${support.reason ?? '宿主能力不足'}`);
      seen.add(m.id);
    }
    if (!Array.isArray(body.evidence) || !Array.isArray(body.reviews)) throw new Error('证据和审查须为数组');
    const message = (mid, label = '引用消息') => {
      const m = this.store.get('SELECT * FROM messages WHERE id=? AND group_id=?', mid, groupId);
      if (!m || m.kind !== 'send') throw new Error(`${label}不是当前团队的正式消息`);
      const context = this.store.get('SELECT contract_version FROM message_context WHERE message_id=?', mid);
      if (context?.contract_version !== this.contract(groupId).version) throw new Error('消息不属于当前目标契约版本');
      return m;
    };
    for (const mid of body.evidence) {
      if (typeof mid !== 'string' || !mid.trim()) throw new Error('成果证据必须是当前团队的正式消息ID');
      const m = message(mid, '成果证据');
      if (!body.participants.some(p => p.memberId === m.sender && p.role !== 'reviewer')) throw new Error('贡献证据必须来自执行者或协作者');
    }
    for (const review of body.reviews) {
      if (!review || typeof review !== 'object' || Array.isArray(review) || typeof review.messageId !== 'string' || !review.messageId.trim()) {
        throw new Error('审查引用必须包含 messageId 和 artifact');
      }
      text(review.artifact, '审查成果版本');
      const m = message(review.messageId, '审查引用');
      if (!body.participants.some(p => p.memberId === m.sender && p.role === 'reviewer')) throw new Error('审查意见必须来自独立审查者');
      if (!body.artifact || review.artifact !== body.artifact) throw new Error('审查与成果版本不一致');
    }
    if (previous?.state === 'accepted' && state === 'accepted' && digest(body) !== digest(Object.fromEntries(Object.keys(body).map(k => [k, previous[k]])))) throw new Error('改变已接受成果必须先重新打开');
    if (state !== previous?.state || c.note) text(c.note, '状态变更理由');
    if (state === 'pending_decision' || state === 'accepted') {
      if (!body.artifact || !body.evidence.length) throw new Error('成果版本和证据尚未齐备');
      if (body.reviewRequired && !body.reviews.length) throw new Error('必要独立审查尚未完成');
    }
    if (state === 'cancelled' && previous?.state !== 'cancelled') {
      if (!c.cancellation || !['covered', 'irrelevant'].includes(c.cancellation.kind)) throw new Error('取消必须说明责任覆盖或与目标无关的依据');
      text(c.cancellation.reason, '取消依据');
      if (c.cancellation.kind === 'covered') {
        if (!c.cancellation.by?.length) throw new Error('需要覆盖责任的其他工作项');
        for (const other of c.cancellation.by) {
          const target = this.item(other, groupId);
          if (other === id || target.goalVersion !== goalState.goal_version || target.state !== 'accepted') throw new Error('覆盖项必须是当前目标的其他已接受成果');
        }
      }
      body.cancellation = c.cancellation;
    } else if (previous?.cancellation) body.cancellation = previous.cancellation;
    const next = (previous?.revision ?? 0) + 1;
    if (creating) this.store.run(
      'INSERT INTO work_items(id,group_id,goal_version,revision,state,body,goal_id) VALUES(?,?,?,?,?,?,?)',
      id,
      groupId,
      goalState.goal_version,
      next,
      state,
      json(body),
      this.currentGoalId(groupId),
    );
    else this.store.run('UPDATE work_items SET revision=?,state=?,body=? WHERE id=?', next, state, json(body), id);
    this.record(groupId, id, 'work_item', { actor: 'lead', from: previous?.state ?? null, state, note: c.note ?? '', itemRevision: next, body });
    return { item: this.item(id, groupId) };
  }
  request(groupId, kind, body) {
    const s = kind === 'next_goal' ? this.requireNextGoal(groupId) : this.requireActive(groupId);
    const id = randomUUID();
    if (kind === 'contract' || kind === 'next_goal') body = { contract: validateContract(body.contract), reason: text(body.reason, kind === 'next_goal' ? '新目标理由' : '变更原因') };
    else if (kind !== 'member_add') throw new Error('未知确认请求');
    this.store.run('INSERT INTO change_requests(id,group_id,base_version,kind,body,created) VALUES(?,?,?,?,?,?)', id, groupId, s.contract_version, kind, json(body), now());
    return { requestId: id, state: 'pending', requiresUser: true };
  }
  decideRequest(groupId, id, approved, version, hasRunning) {
    return this.store.transaction(() => {
      const r = this.store.get('SELECT * FROM change_requests WHERE id=? AND group_id=?', id, groupId);
      if (!r || r.state !== 'pending') throw new Error('待确认请求不存在');
      const s = r.kind === 'next_goal' ? this.requireNextGoal(groupId) : this.requireActive(groupId);
      if (s.contract_version !== version || r.base_version !== version) throw new Error('确认基准版本已过期');
      if (approved && hasRunning) throw new Error('请先收束当前回合，再批准变更');
      if (approved && r.kind === 'contract') {
        const body = parse(r.body).contract;
        this.store.run('INSERT INTO contract_versions VALUES(?,?,?,?,?,?)', groupId, version + 1, json(body), digest(body), json({ requestId: id, source: 'local-user' }), now());
        this.store.run('UPDATE team_state SET contract_version=contract_version+1,revision=revision+1 WHERE group_id=?', groupId);
      } else if (approved && r.kind === 'next_goal') {
        const body = parse(r.body).contract;
        this.store.run('INSERT INTO contract_versions VALUES(?,?,?,?,?,?)', groupId, version + 1, json(body), digest(body), json({ requestId: id, source: 'local-user', goalVersion: s.goal_version + 1 }), now());
        this.store.run("UPDATE team_state SET goal_version=goal_version+1,contract_version=contract_version+1,phase='active',outcome=NULL,final=NULL,finish_reason=NULL,revision=revision+1 WHERE group_id=?", groupId);
      }
      this.store.run('UPDATE change_requests SET state=? WHERE id=?', approved ? 'approved' : 'rejected', id);
      this.record(groupId, null, 'user_decision', { requestId: id, approved, kind: r.kind, version });
      return { ...parse(r.body), kind: r.kind, approved };
    });
  }
  finish(groupId, c) {
    if (c.outcome !== 'completed') throw new Error('未完成终止需要用户通过terminate明确决定');
    text(c.final, '最终交付'); text(c.note, '收尾理由');
    const items = this.currentItems(groupId);
    if (items.some(i => !['accepted', 'cancelled'].includes(i.state))) throw new Error('仍有未关闭工作项');
    for (const criterion of this.contract(groupId).body.criteria) {
      const ids = c.coverage?.[criterion.id];
      if (!Array.isArray(ids) || !ids.length || ids.some(id => !items.some(i => i.id === id && i.state === 'accepted'))) throw new Error(`完成条件${criterion.id}缺少已接受成果覆盖`);
    }
    const dispositions = c.dispositions ?? [];
    if (!Array.isArray(dispositions)) throw new Error('dispositions必须是数组');
    const supplied = new Set();
    for (const d of dispositions) {
      if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.messageId !== 'string' || !d.messageId.trim()) {
        throw new Error('dispositions每项必须包含 messageId 和 reason');
      }
      const m = this.store.get('SELECT id FROM messages WHERE id=? AND group_id=? AND kind=\'send\'', d?.messageId, groupId);
      if (!m) throw new Error('收尾消息不存在');
      if (supplied.has(m.id)) throw new Error(`消息${m.id}重复给出处理理由`);
      supplied.add(m.id);
      text(d.reason, '消息处理理由');
    }
    const pending = this.pending(groupId);
    const missing = pending.filter(m => !supplied.has(m.id));
    if (missing.length) throw new Error(`仍有未处理消息，请读取消息并为每条提供dispositions：${missing.map(m => `${m.seq}:${m.id}`).join(', ')}`);
    for (const d of dispositions) {
      this.store.run('INSERT INTO message_dispositions VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,created=excluded.created', d.messageId, 'handled', d.reason, now());
    }
    this.store.run("UPDATE team_state SET phase='closing',outcome='completed',final=?,finish_reason=? WHERE group_id=?", c.final, c.note, groupId);
    this.record(groupId, null, 'finish_requested', { coverage: c.coverage, note: c.note });
    return { phase: 'closing' };
  }
  pending(groupId) {
    return this.store.all(`SELECT m.id,m.seq,m.sender,m.recipient,m.text FROM messages m WHERE m.group_id=? AND m.kind='send'
      AND NOT EXISTS(SELECT 1 FROM message_dispositions d WHERE d.message_id=m.id)
      AND (
        NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=m.id)
        OR EXISTS(SELECT 1 FROM attached a JOIN outbox o ON o.id=a.outbox_id WHERE a.message_id=m.id AND o.accepted IS NULL)
      )
      AND (
        NOT EXISTS(SELECT 1 FROM panel_attached p WHERE p.message_id=m.id)
        OR EXISTS(SELECT 1 FROM panel_attached p JOIN panel_outbox o ON o.id=p.outbox_id WHERE p.message_id=m.id AND o.accepted IS NULL)
      ) ORDER BY m.seq`, groupId);
  }
  reconcile(groupId, running, { ignorePending = false } = {}) {
    const s = this.state(groupId);
    if (!s || s.phase !== 'closing' || running || this.unknown(groupId).length) return false;
    if (!ignorePending && this.pending(groupId).length) return false;
    this.store.transaction(() => {
      this.store.run("UPDATE team_state SET phase='closed',revision=revision+1 WHERE group_id=?", groupId);
      this.store.run(
        'INSERT INTO user_outputs(id,group_id,goal_version,body,created,goal_id) VALUES(?,?,?,?,?,?)',
        randomUUID(),
        groupId,
        s.goal_version,
        s.final ?? s.finish_reason,
        now(),
        this.goalIdForVersion(groupId, s.goal_version),
      );
      this.record(groupId, null, 'closed', { outcome: s.outcome });
    });
    return true;
  }
  terminate(groupId, reason) {
    this.store.group(groupId);
    if (!this.state(groupId)) throw new Error('旧群仅供查看');
    if (this.state(groupId).phase === 'closed') throw new Error('团队已结束，不能改写结束结果');
    text(reason, '终止原因');
    this.store.transaction(() => {
      this.store.run("UPDATE team_state SET phase='closing',outcome='incomplete',finish_reason=?,final=?,revision=revision+1 WHERE group_id=?", reason, `任务未完成，用户终止：${reason}`, groupId);
      for (const m of this.pending(groupId)) this.store.run('INSERT OR REPLACE INTO message_dispositions VALUES(?,?,?,?)', m.id, 'cancelled', reason, now());
      this.record(groupId, null, 'user_terminated', { reason });
    });
  }
  reopen(groupId, reason) {
    const s = this.state(groupId);
    if (s?.phase !== 'closing') throw new Error('只能撤回尚未结束的收尾请求');
    text(reason, '撤回理由');
    this.store.run("UPDATE team_state SET phase='active',outcome=NULL,final=NULL,revision=revision+1 WHERE group_id=?", groupId);
    this.record(groupId, null, 'finish_withdrawn', { reason });
  }
  resolveRuntime(groupId, turnId, reason) {
    text(reason, '用户核实依据');
    const changed = this.store.run("UPDATE runtime_attempts SET state='stopped',detail=?,ended=? WHERE group_id=? AND turn_id=? AND state='unknown'", `用户核实：${reason}`, now(), groupId, turnId);
    if (!changed.changes) throw new Error('待核实运行不存在');
    this.record(groupId, null, 'runtime_verified_by_user', { turnId, reason });
  }
}
