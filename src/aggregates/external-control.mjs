// 外部主控聚合:principal、client binding、团队控制权、外部收件箱、桌面应用
// 注册表与主控 workspace 跟随的事实边界。
// 外部主控不是成员或 Panel Agent，连接只是 principal 的一个可撤销宿主会话。
// 桌面语境下 binding 即「主控会话」:surface 区分 cli/desktop,app_id 指向安装记录。
import * as teamsAgg from './teams.mjs';
import * as turnsAgg from './turns.mjs';
import * as conversationsAgg from './conversations.mjs';

export function principal(store, id) {
  return store.get('SELECT * FROM external_principals WHERE id=?', id) ?? null;
}

export function principalByName(store, name) {
  return store.get('SELECT * FROM external_principals WHERE name=?', name) ?? null;
}

export function insertPrincipal(store, { id, name, created, updated = created }) {
  return store.run(
    'INSERT INTO external_principals(id,name,created,updated) VALUES(?,?,?,?)',
    id, name, created, updated,
  );
}

export function binding(store, id) {
  return store.get(
    `SELECT b.*,p.name AS principal_name
     FROM external_client_bindings b JOIN external_principals p ON p.id=b.principal_id
     WHERE b.id=?`,
    id,
  ) ?? null;
}

export function bindingsForPrincipal(store, principalId) {
  return store.all(
    'SELECT * FROM external_client_bindings WHERE principal_id=? ORDER BY created',
    principalId,
  );
}

export function bindingByName(store, principalId, name) {
  return store.get(
    'SELECT * FROM external_client_bindings WHERE principal_id=? AND name=?',
    principalId, name,
  ) ?? null;
}

export function insertBinding(store, {
  id, principalId, name, host, command = null, keyHash, session = null,
  declaredCapabilities, appId = null, surface = 'cli', created, updated = created,
}) {
  return store.run(
    `INSERT INTO external_client_bindings(
       id,principal_id,name,host,command,key_hash,session,declared_capabilities,app_id,surface,status,created,updated
     ) VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
    id, principalId, name, host, command, keyHash, session,
    JSON.stringify(declaredCapabilities), appId, surface,
    created, updated,
  );
}

export function touchBinding(store, id, now = new Date().toISOString()) {
  return store.run('UPDATE external_client_bindings SET last_seen=?,updated=? WHERE id=?', now, now, id);
}

export function setBindingSession(store, id, session, now = new Date().toISOString()) {
  if (typeof session !== 'string' || !session.trim()) return false;
  return store.run(
    'UPDATE external_client_bindings SET session=?,updated=? WHERE id=? AND (session IS NULL OR session!=?)',
    session.trim(), now, id, session.trim(),
  ).changes > 0;
}

export function clearBindingSession(store, id, now = new Date().toISOString()) {
  return store.run(
    'UPDATE external_client_bindings SET session=NULL,updated=? WHERE id=? AND session IS NOT NULL',
    now, id,
  ).changes > 0;
}

export function disableBinding(store, id, now = new Date().toISOString()) {
  return store.run("UPDATE external_client_bindings SET status='disabled',updated=? WHERE id=?", now, id);
}

export function rotateBinding(store, id, {
  host, command, keyHash, session, declaredCapabilities, appId = null, surface = 'cli', updated,
}) {
  return store.run(
    `UPDATE external_client_bindings
     SET host=?,command=?,key_hash=?,session=?,declared_capabilities=?,app_id=?,surface=?,wake_config=NULL,status='active',updated=?
     WHERE id=?`,
    host, command, keyHash, session,
    JSON.stringify(declaredCapabilities), appId, surface,
    updated, id,
  );
}

export function setBindingWakeConfig(store, id, config, now = new Date().toISOString()) {
  return store.run(
    'UPDATE external_client_bindings SET wake_config=?,updated=? WHERE id=?',
    config == null ? null : JSON.stringify(config), now, id,
  );
}

export function setBindingWakeState(store, id, {
  state,
  mode = null,
  reason = null,
  fingerprint = null,
  verifiedAt = null,
  attempts = null,
  nextAttempt = null,
  now = new Date().toISOString(),
}) {
  if (!['unverified', 'provisioning', 'ready', 'degraded', 'unsupported'].includes(state)) {
    throw new Error(`未知唤醒状态: ${state}`);
  }
  return store.run(
    `UPDATE external_client_bindings
     SET wake_state=?,wake_mode=?,wake_reason=?,wake_fingerprint=COALESCE(?,wake_fingerprint),
         wake_verified_at=COALESCE(?,wake_verified_at),wake_attempts=COALESCE(?,wake_attempts),
         wake_next_attempt=?,updated=?
     WHERE id=?`,
    state, mode, reason, fingerprint, verifiedAt, attempts, nextAttempt, now, id,
  );
}

export function acceptPullOnly(store, id, now = new Date().toISOString()) {
  return store.run(
    `UPDATE external_client_bindings
     SET pull_only_accepted=?,wake_state='degraded',wake_reason='用户已接受仅拉取模式',updated=?
     WHERE id=?`,
    now, now, id,
  );
}

export function clearPullOnly(store, id, now = new Date().toISOString()) {
  return store.run(
    'UPDATE external_client_bindings SET pull_only_accepted=NULL,updated=? WHERE id=?',
    now, id,
  );
}

// --- 桌面应用注册表(Phase 1 事实存储;检测与验证服务在后续阶段接入) ----------

export function application(store, id) {
  return store.get('SELECT * FROM desktop_applications WHERE id=?', id) ?? null;
}

export function applications(store) {
  return store.all('SELECT * FROM desktop_applications ORDER BY kind,created');
}

/** 按安装身份定位:同一 (kind,surface,install_path) 只有一行,重复检测走更新。 */
export function applicationForInstance(store, { kind, surface = 'desktop', installPath = null }) {
  return store.get(
    'SELECT * FROM desktop_applications WHERE kind=? AND surface=? AND install_path IS ?',
    kind, surface, installPath,
  ) ?? null;
}

export function upsertApplication(store, {
  id, kind, surface = 'desktop', installPath = null, enginePath = null, engineVersion = null, created,
}) {
  const existing = applicationForInstance(store, { kind, surface, installPath });
  if (existing) {
    store.run(
      `UPDATE desktop_applications
       SET engine_path=COALESCE(?,engine_path),engine_version=COALESCE(?,engine_version),updated=?
       WHERE id=?`,
      enginePath, engineVersion, created, existing.id,
    );
    return { ...application(store, existing.id), created: false };
  }
  store.run(
    `INSERT INTO desktop_applications(
       id,kind,surface,install_path,engine_path,engine_version,readiness,created,updated
     ) VALUES(?,?,?,?,?,?, 'unavailable',?,?)`,
    id, kind, surface, installPath, enginePath, engineVersion, created, created,
  );
  return { ...application(store, id), created: true };
}

/** 验证结果整体落库:readiness 是唯一的用户可见结论,pull_only 只是它的修饰。 */
export function setApplicationVerification(store, id, {
  readiness,
  pullOnly = null,
  controllerState = null,
  engineState = null,
  diagnostics = null,
  fingerprint = null,
  verifiedAt = null,
  lifecycleNote = null,
  now = new Date().toISOString(),
}) {
  if (!['available', 'unavailable'].includes(readiness)) throw new Error(`未知应用就绪状态: ${readiness}`);
  store.run(
    `UPDATE desktop_applications
     SET readiness=?,pull_only=COALESCE(?,pull_only),controller_state=COALESCE(?,controller_state),
         engine_state=COALESCE(?,engine_state),diagnostics=COALESCE(?,diagnostics),
         fingerprint=COALESCE(?,fingerprint),verified_at=COALESCE(?,verified_at),
         lifecycle_note=COALESCE(?,lifecycle_note),updated=?
     WHERE id=?`,
    readiness,
    pullOnly == null ? null : (pullOnly ? 1 : 0),
    controllerState, engineState,
    diagnostics == null ? null : JSON.stringify(diagnostics),
    fingerprint, verifiedAt, lifecycleNote, now, id,
  );
  return application(store, id);
}

/** 主控会话当前工作目录:只在变化时写入,返回是否变化(跟随流程的触发信号)。 */
export function setBindingControllerCwd(store, id, cwd, now = new Date().toISOString()) {
  if (typeof cwd !== 'string' || !cwd.trim()) return false;
  const normalized = cwd.trim();
  const current = store.get('SELECT controller_cwd FROM external_client_bindings WHERE id=?', id);
  if (!current) throw new Error('主控连接不存在');
  if (current.controller_cwd === normalized) return false;
  store.run(
    'UPDATE external_client_bindings SET controller_cwd=?,controller_cwd_updated=?,updated=? WHERE id=?',
    normalized, now, now, id,
  );
  return true;
}

export function controlledTeams(store, principalId) {
  return store.all(
    `SELECT g.id,g.name,g.workspace,g.charter,g.policy,g.allow_shell,g.created,g.state,
            c.controller_binding_id,c.revision AS controller_revision,c.updated AS controller_updated
     FROM team_lead_controllers c JOIN groups g ON g.id=c.group_id
     WHERE c.controller_kind='external_agent' AND c.controller_id=? AND c.state='active'
     ORDER BY g.created`,
    principalId,
  );
}

export function controlsTeam(store, principalId, groupId) {
  return Boolean(store.get(
    `SELECT 1 FROM team_lead_controllers
     WHERE group_id=? AND controller_kind='external_agent' AND controller_id=? AND state='active'`,
    groupId, principalId,
  ));
}

/** 该 binding 当前持有席位的团队(workspace 跟随、唤醒按会话而非 principal 判定)。 */
export function activeTeamsForBinding(store, bindingId) {
  return store.all(
    `SELECT g.* FROM team_lead_controllers c JOIN groups g ON g.id=c.group_id
     WHERE c.controller_kind='external_agent' AND c.controller_binding_id=? AND c.state='active'
     ORDER BY g.created`,
    bindingId,
  );
}

export function activateTeam(store, { groupId, principalId, bindingId, now }) {
  const row = store.get(
    `SELECT revision FROM team_lead_controllers
     WHERE group_id=? AND controller_kind='external_agent' AND controller_id=? AND state='active'`,
    groupId, principalId,
  );
  if (!row) throw new Error('外部主控无权激活该团队');
  store.run(
    `UPDATE team_lead_controllers
     SET controller_binding_id=?,revision=revision+1,updated=?
     WHERE group_id=? AND controller_kind='external_agent' AND controller_id=? AND state='active'`,
    bindingId, now, groupId, principalId,
  );
  return store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId);
}

export function activeBindingForTeam(store, principalId, groupId) {
  return store.get(
    `SELECT b.* FROM team_lead_controllers c
     JOIN external_client_bindings b ON b.id=c.controller_binding_id
     WHERE c.group_id=? AND c.controller_kind='external_agent' AND c.controller_id=?
       AND c.state='active' AND b.status='active'`,
    groupId, principalId,
  ) ?? null;
}

// --- 团队主控关系(计划 §2.3) ------------------------------------------------
// 关系表记录「哪些 binding 建立过访问」;谁是活跃席位由 team_lead_controllers
// 推导,这里不存第二份活跃状态。接管后旧 binding 保留关系,自然只读。

export function establishRelation(store, { groupId, principalId, bindingId, origin = 'takeover', created, now = created }) {
  return store.run(
    `INSERT INTO team_controller_relations(group_id,binding_id,principal_id,origin,revision,created,updated)
     VALUES(?,?,?,?,1,?,?)
     ON CONFLICT(group_id,binding_id) DO UPDATE SET updated=excluded.updated,revision=team_controller_relations.revision+1`,
    groupId, bindingId, principalId, origin, created, now,
  );
}

export function relationFor(store, groupId, bindingId) {
  return store.get(
    'SELECT * FROM team_controller_relations WHERE group_id=? AND binding_id=?',
    groupId, bindingId,
  ) ?? null;
}

export function relationsForTeam(store, groupId) {
  return store.all(
    `SELECT r.*,b.name AS binding_name,b.host AS binding_host,b.surface
     FROM team_controller_relations r
     JOIN external_client_bindings b ON b.id=r.binding_id
     WHERE r.group_id=? ORDER BY r.created`,
    groupId,
  );
}

/** 列表可见性:只返回与该 binding 建立过关系的团队;active 由席位推导。 */
export function teamsForBinding(store, bindingId) {
  return store.all(
    `SELECT g.id,g.name,g.workspace,g.workspace_pending,g.charter,g.policy,g.allow_shell,g.created,g.state,
            c.controller_binding_id,c.revision AS controller_revision,c.updated AS controller_updated,
            r.origin AS relation_origin,r.created AS related_since
     FROM team_controller_relations r
     JOIN groups g ON g.id=r.group_id
     LEFT JOIN team_lead_controllers c
       ON c.group_id=g.id AND c.controller_kind='external_agent' AND c.state='active'
     WHERE r.binding_id=?
     ORDER BY g.created`,
    bindingId,
  );
}

/**
 * 同用户按团队 ID 直接接管(ADR 0010):无需第二次确认。
 * 前置:团队席位是同一 principal 的 external_agent。确立关系、移交席位、
 * 返回原席位 binding 以便调用方唤醒旧主控并安排 workspace 切换。
 */
export function takeoverTeam(store, { groupId, principalId, bindingId, now }) {
  return store.transaction(() => {
    const seat = store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId);
    if (!seat || seat.controller_kind !== 'external_agent' || seat.controller_id !== principalId) {
      throw new Error('该团队的主控不是当前用户的外部主控会话，无法按团队 ID 接管');
    }
    const previousBindingId = seat.controller_binding_id;
    establishRelation(store, { groupId, principalId, bindingId, origin: 'takeover', created: now, now });
    const assignment = activateTeam(store, { groupId, principalId, bindingId, now });
    return { previousBindingId, assignment };
  });
}

// --- Controller workspace 跟随(ADR 0012) ------------------------------------
// 目录切换流程:主控会话工作目录变化 -> 请求切换;有运行中回合则记 pending
// 并由派发守卫拦截新工;旧目录回合结算后由 settle 生效并失效成员旧目录会话。

function applyWorkspace(store, { groupId, workspace, previous, now }) {
  const revision = teamsAgg.setGroupWorkspace(store, { groupId, workspace });
  teamsAgg.insertWorkspaceEvent(store, {
    groupId, kind: 'applied', fromPath: previous, toPath: workspace, revision, created: now,
  });
  // 旧目录上下文的成员会话全部失效;下一回合按新目录重建,不混用两代目录。
  for (const member of store.all('SELECT id FROM members WHERE group_id=? AND removed IS NULL', groupId)) {
    conversationsAgg.clearSessionsForMember(store, member.id);
  }
}

/**
 * 记录一次主控工作目录变化对团队的影响。
 * 目录与生效目录一致时视为无变化;若有待定切换(用户中途改回),取消待定并留痕。
 */
export function requestControllerWorkspace(store, { groupId, cwd, now = new Date().toISOString() }) {
  return store.transaction(() => {
    const group = store.get('SELECT workspace,workspace_pending FROM groups WHERE id=?', groupId);
    if (!group) throw new Error('群不存在');
    if (group.workspace === cwd) {
      if (group.workspace_pending) {
        store.run('UPDATE groups SET workspace_pending=NULL WHERE id=?', groupId);
        teamsAgg.insertWorkspaceEvent(store, {
          groupId, kind: 'cancelled', toPath: group.workspace_pending,
          detail: '主控目录改回当前生效目录，待定切换取消', created: now,
        });
      }
      return { changed: false };
    }
    if (group.workspace_pending === cwd) return { changed: false, pending: true };
    if (turnsAgg.hasRunningTurnsForGroup(store, groupId)) {
      teamsAgg.setGroupPendingWorkspace(store, { groupId, workspace: cwd });
      teamsAgg.insertWorkspaceEvent(store, {
        groupId, kind: 'pending', fromPath: group.workspace, toPath: cwd,
        detail: '旧目录回合运行中，切换待结算', created: now,
      });
      return { changed: true, pending: true };
    }
    applyWorkspace(store, { groupId, workspace: cwd, previous: group.workspace, now });
    return { changed: true, pending: false };
  });
}

/** pump 结算:无运行中回合的待定切换在此生效;结算前派发守卫拦截新工。 */
export function settlePendingWorkspaces(store, now = new Date().toISOString()) {
  const applied = [];
  for (const row of teamsAgg.pendingWorkspaceGroups(store)) {
    if (turnsAgg.hasRunningTurnsForGroup(store, row.id)) continue;
    const group = store.get('SELECT workspace FROM groups WHERE id=?', row.id);
    store.transaction(() => {
      applyWorkspace(store, { groupId: row.id, workspace: row.workspace_pending, previous: group.workspace, now });
    });
    applied.push(row.id);
  }
  return applied;
}

export function enqueueDelivery(store, { id, principalId, groupId, messageId, payload, created }) {
  return store.run(
    `INSERT OR IGNORE INTO external_deliveries(
       id,principal_id,group_id,message_id,payload,state,wake_state,created
     ) VALUES(?,?,?,?,?,'pending','pending',?)`,
    id, principalId, groupId, messageId, JSON.stringify(payload), created,
  );
}

export function pendingWakes(store, principalId, groupId) {
  return store.all(
    `SELECT * FROM external_deliveries
     WHERE principal_id=? AND group_id=? AND state='pending'
       AND wake_state IN ('pending','unsupported','error')
     ORDER BY created,rowid`,
    principalId, groupId,
  );
}

export function markWake(store, ids, {
  bindingId = null, state, error = null, now = new Date().toISOString(),
}) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  return store.transaction(() => {
    let changed = 0;
    const transition = state === 'sending'
      ? "wake_state IN ('pending','unsupported','error')"
      : "wake_state IN ('pending','sending')";
    for (const id of ids) {
      changed += store.run(
        `UPDATE external_deliveries
         SET wake_state=?,wake_error=?,wake_updated=?,binding_id=COALESCE(?,binding_id)
         WHERE id=? AND ${transition}`,
        state, error, now, bindingId, id,
      ).changes;
    }
    return changed;
  });
}

export function pendingDeliveries(store, principalId) {
  return store.all(
    `SELECT * FROM external_deliveries
     WHERE principal_id=? AND state='pending' ORDER BY created,rowid`,
    principalId,
  );
}

/**
 * 领取动作只对尚未领取的行生效；重复调用不会重复返回同一条消息。
 * 领取表示客户端已拉取并接受团队输入，不表示宿主已经完成业务工作。
 */
export function claimDeliveries(store, { principalId, bindingId, limit, now }) {
  return store.transaction(() => {
    const rows = store.all(
      `SELECT d.* FROM external_deliveries d
       JOIN team_lead_controllers c
         ON c.group_id=d.group_id AND c.controller_kind='external_agent'
        AND c.controller_id=d.principal_id AND c.controller_binding_id=? AND c.state='active'
       WHERE d.principal_id=? AND d.state='pending'
       ORDER BY d.created,d.rowid LIMIT ?`,
      bindingId, principalId, limit,
    );
    for (const row of rows) {
      store.run(
        `UPDATE external_deliveries
         SET state='delivered',binding_id=?,delivered=?,
             wake_state=CASE WHEN wake_state='pending' THEN 'sent' ELSE wake_state END,
             wake_updated=CASE WHEN wake_state='pending' THEN ? ELSE wake_updated END
         WHERE id=? AND state='pending'`,
        bindingId, now, now, row.id,
      );
      store.run('UPDATE messages SET awaiting=0 WHERE id=?', row.message_id);
    }
    return rows.map(row => {
      const payload = JSON.parse(row.payload);
      if (payload.message) payload.message = { ...payload.message, awaiting: 0 };
      return {
        ...row,
        state: 'delivered',
        binding_id: bindingId,
        delivered: now,
        payload,
      };
    });
  });
}

export function deliveryStatus(store, principalId) {
  const wakeCounts = Object.fromEntries(
    ['pending', 'sending', 'sent', 'unsupported', 'error'].map(state => [
      state,
      store.get(
        'SELECT count(*) AS count FROM external_deliveries WHERE principal_id=? AND wake_state=?',
        principalId, state,
      ).count,
    ]),
  );
  return {
    pending: store.get(
      "SELECT count(*) AS count FROM external_deliveries WHERE principal_id=? AND state='pending'",
      principalId,
    ).count,
    error: store.get(
      "SELECT count(*) AS count FROM external_deliveries WHERE principal_id=? AND state='error'",
      principalId,
    ).count,
    wake: {
      ...wakeCounts,
      queued: wakeCounts.sending,
      started: wakeCounts.sent,
      failed: wakeCounts.error,
    },
  };
}

export function insertDecision(store, {
  id, groupId, requesterMemberId, controllerPrincipalId,
  requestMessageId, payload, created,
}) {
  return store.run(
    `INSERT INTO external_decisions(
       id,group_id,requester_member_id,controller_principal_id,request_message_id,payload,state,created
     ) VALUES(?,?,?,?,?,?,'pending',?)`,
    id, groupId, requesterMemberId, controllerPrincipalId, requestMessageId, JSON.stringify(payload), created,
  );
}

export function decision(store, id) {
  return store.get('SELECT * FROM external_decisions WHERE id=?', id) ?? null;
}

export function pendingDecisions(store, principalId, { groupId = null, limit = 50 } = {}) {
  return store.all(
    `SELECT * FROM external_decisions
     WHERE controller_principal_id=? AND state='pending'${groupId ? ' AND group_id=?' : ''}
     ORDER BY created,rowid LIMIT ?`,
    ...(groupId ? [principalId, groupId, limit] : [principalId, limit]),
  ).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
}

export function answerDecision(store, {
  id, principalId, bindingId, answer, answered,
}) {
  return store.transaction(() => {
    const row = decision(store, id);
    if (!row || row.controller_principal_id !== principalId) throw new Error('决策请求不属于当前外部主控');
    if (row.state !== 'pending') throw new Error('决策请求已经处理');
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 16000) throw new Error('决策答复无效');
    store.run(
      "UPDATE external_decisions SET state='answered',answer=?,answered_by_binding_id=?,answered=? WHERE id=? AND state='pending'",
      answer.trim(), bindingId, answered, id,
    );
    return { ...row, state: 'answered', answer: answer.trim(), answered_by_binding_id: bindingId, answered };
  });
}
