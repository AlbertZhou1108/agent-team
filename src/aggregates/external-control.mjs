// 外部主控聚合:principal、client binding、团队控制权和外部收件箱的事实边界。
// 外部主控不是成员或 Panel Agent，连接只是 principal 的一个可撤销宿主会话。

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
  declaredCapabilities, probedCapabilities, created, updated = created,
}) {
  return store.run(
    `INSERT INTO external_client_bindings(
       id,principal_id,name,host,command,key_hash,session,declared_capabilities,probed_capabilities,status,created,updated
     ) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)`,
    id, principalId, name, host, command, keyHash, session,
    JSON.stringify(declaredCapabilities), JSON.stringify(probedCapabilities),
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
  host, command, keyHash, session, declaredCapabilities, probedCapabilities, updated,
}) {
  return store.run(
    `UPDATE external_client_bindings
     SET host=?,command=?,key_hash=?,session=?,declared_capabilities=?,probed_capabilities=?,wake_config=NULL,status='active',updated=?
     WHERE id=?`,
    host, command, keyHash, session,
    JSON.stringify(declaredCapabilities), JSON.stringify(probedCapabilities),
    updated, id,
  );
}

export function setBindingWakeConfig(store, id, config, now = new Date().toISOString()) {
  return store.run(
    'UPDATE external_client_bindings SET wake_config=?,updated=? WHERE id=?',
    config == null ? null : JSON.stringify(config), now, id,
  );
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
        "UPDATE external_deliveries SET state='delivered',binding_id=?,delivered=? WHERE id=? AND state='pending'",
        bindingId, now, row.id,
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
  return {
    pending: store.get(
      "SELECT count(*) AS count FROM external_deliveries WHERE principal_id=? AND state='pending'",
      principalId,
    ).count,
    error: store.get(
      "SELECT count(*) AS count FROM external_deliveries WHERE principal_id=? AND state='error'",
      principalId,
    ).count,
    wake: Object.fromEntries(
      ['pending', 'sending', 'sent', 'unsupported', 'error'].map(state => [
        state,
        store.get(
          'SELECT count(*) AS count FROM external_deliveries WHERE principal_id=? AND wake_state=?',
          principalId, state,
        ).count,
      ]),
    ),
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
