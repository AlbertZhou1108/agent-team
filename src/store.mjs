import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_ATTACHMENT_SETTINGS, normalizeAttachmentSettings, serializeAttachmentSettings } from './attachment-settings.mjs';
import { SCHEMA_VERSION, ensureCurrentSchema, ensureAuxiliarySchema, ensureV2Schema, seedGlobalModelPolicyAndRoleNames } from './store/schema.mjs';
import * as migrations from './store/migrations.mjs';
import * as traceQueries from './store/trace-queries.mjs';

export { SCHEMA_VERSION };

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = resolve(directory);
    this.savepointDepth = 0;
    this.db = new DatabaseSync(resolve(directory, 'groups.sqlite'));
    chmodSync(resolve(directory, 'groups.sqlite'), 0o600);
    // 版本必须在建表前读取：新库与 v0 旧库都返回 0，用「是否存在任何用户表」区分。
    const existingVersion = this.schemaVersion();
    if (existingVersion > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`数据目录由更新版本的 Agent Team 创建（schema ${existingVersion}），当前版本只支持到 ${SCHEMA_VERSION}`);
    }
    this.isFreshDatabase = existingVersion === 0 && !this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    if (this.isFreshDatabase) {
      // 新库：直接建立当前版本完整 Schema，不回放历史迁移阶梯。
      ensureCurrentSchema(this);
      this.setSchemaVersion(SCHEMA_VERSION);
    } else {
      if (existingVersion < 2) this.upgradeFromV1();
      this.migrateSchema(existingVersion);
      this.ensureV2Schema();
      ensureAuxiliarySchema(this);
      if (this.schemaVersion() !== SCHEMA_VERSION) this.setSchemaVersion(SCHEMA_VERSION);
    }
    seedGlobalModelPolicyAndRoleNames(this);
  }

  upgradeFromV1() { return migrations.upgradeFromV1(this); }
  migrateSchema(fromVersion) { return migrations.migrateSchema(this, fromVersion); }
  migrateV2() { return migrations.migrateV2(this); }
  migrateV3() { return migrations.migrateV3(this); }
  migrateV4() { return migrations.migrateV4(this); }
  migrateV5() { return migrations.migrateV5(this); }
  migrateV6() { return migrations.migrateV6(this); }
  migrateV7() { return migrations.migrateV7(this); }
  migrateV8() { return migrations.migrateV8(this); }
  migrateV9() { return migrations.migrateV9(this); }
  migrateV10() { return migrations.migrateV10(this); }
  migrateV11() { return migrations.migrateV11(this); }
  migrateV12() { return migrations.migrateV12(this); }
  migrateV13() { return migrations.migrateV13(this); }
  migrateV14() { return migrations.migrateV14(this); }
  migrateV15() { return migrations.migrateV15(this); }
  migrateV16() { return migrations.migrateV16(this); }
  migrateV17() { return migrations.migrateV17(this); }
  migrateV18() { return migrations.migrateV18(this); }
  migrateV19() { return migrations.migrateV19(this); }
  migrateV20() { return migrations.migrateV20(this); }
  migrateV21() { return migrations.migrateV21(this); }
  migrateV22() { return migrations.migrateV22(this); }
  migrateV23() { return migrations.migrateV23(this); }
  migrateV24() { return migrations.migrateV24(this); }
  migrate() { return migrations.migrate(this); }
  migrateAttachments() { return migrations.migrateAttachments(this); }
  migrateAgentTasks() { return migrations.migrateAgentTasks(this); }
  migrateInteractions() { return migrations.migrateInteractions(this); }
  ensureV2Schema() { return ensureV2Schema(this); }

  schemaVersion() {
    return Number(this.db.prepare('PRAGMA user_version').get().user_version ?? 0);
  }

  setSchemaVersion(version) {
    if (!Number.isInteger(version) || version < 0) throw new Error('无效的 schema 版本');
    this.db.exec(`PRAGMA user_version = ${version}`);
  }

  // 版本迁移钩子:按 user_version 逐级执行。v1 -> v2 的会话/回合/投递合并
  // 在单个事务内完成，失败回滚；迁移后由 foreign_key_check 兜底。

  all(sql, ...args) { return this.db.prepare(sql).all(...args); }

  get(sql, ...args) { return this.db.prepare(sql).get(...args); }

  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  // 事务可嵌套:顶层开 BEGIN IMMEDIATE,已在事务中时退化为 SAVEPOINT。
  // 调用方不需要知道当前是否处于事务中,也不再需要 isTransaction / transaction:false 之类的绕行。

  transaction(fn) {
    if (this.db.isTransaction) {
      const name = `at_sp_${this.savepointDepth + 1}`;
      this.savepointDepth += 1;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        this.savepointDepth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  group(id) {
    const group = this.get('SELECT * FROM groups WHERE id=?', id);
    if (!group) throw new Error('群不存在');
    return group;
  }
  /** 团队的主控关系:哪些连接建立过访问、当前谁仍持有写入席位。 */

  controllerRelations(groupId) {
    return this.all(
      `SELECT r.binding_id, r.principal_id, r.origin, r.revision, r.created, r.updated,
              b.name AS binding_name, b.surface,
              CASE WHEN l.controller_binding_id IS NULL THEN 0 ELSE 1 END AS active
         FROM team_controller_relations r
         LEFT JOIN external_client_bindings b ON b.id = r.binding_id
         LEFT JOIN team_lead_controllers l
                ON l.group_id = r.group_id AND l.controller_binding_id = r.binding_id AND l.state = 'active'
        WHERE r.group_id = ?
        ORDER BY active DESC, r.updated DESC`,
      groupId,
    );
  }

  member(id) {
    const member = this.get('SELECT * FROM members WHERE id=? AND removed IS NULL', id);
    if (!member) throw new Error('成员不存在或已移除');
    return member;
  }
  // 会话统一入口:v2 起只有 conversations 单表；调用方不关心存储形态。

  conversation(kind, ownerId, context, { peer = null, groupId = null } = {}) {
    if (kind === 'member') {
      const member = this.member(ownerId);
      let row = this.get('SELECT * FROM conversations WHERE member_id=? AND context=?', ownerId, context);
      if (!row) {
        const id = randomUUID();
        const now = new Date().toISOString();
        this.run('INSERT INTO conversations(id,group_id,member_id,panel_agent_id,context,peer,session,policy_signature,key,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          id, member.group_id, member.id, null, context, peer, null, null, randomBytes(32).toString('hex'), now, now);
        row = this.get('SELECT * FROM conversations WHERE id=?', id);
      }
      return { ...row, owner_kind: 'member', owner_id: row.member_id };
    }
    if (kind === 'panel_agent') {
      const existing = context === 'coordination'
        ? this.get("SELECT * FROM conversations WHERE panel_agent_id=? AND context='coordination' AND group_id=?", ownerId, groupId)
        : this.get('SELECT * FROM conversations WHERE panel_agent_id=? AND context=?', ownerId, context);
      if (existing) return { ...existing, owner_kind: 'panel_agent', owner_id: existing.panel_agent_id };
      if (context === 'coordination') this.group(groupId);
      const id = `panel-session-${randomUUID()}`;
      const now = new Date().toISOString();
      this.run('INSERT INTO conversations(id,group_id,member_id,panel_agent_id,context,peer,session,policy_signature,key,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        id, groupId ?? null, null, ownerId, context, null, null, null, randomBytes(32).toString('hex'), now, now);
      return { ...this.get('SELECT * FROM conversations WHERE id=?', id), owner_kind: 'panel_agent', owner_id: ownerId };
    }
    throw new Error(`未知的会话类型: ${kind}`);
  }

  conversationById(id) {
    const row = this.get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return null;
    return { ...row, owner_kind: row.member_id ? 'member' : 'panel_agent', owner_id: row.member_id ?? row.panel_agent_id };
  }
  // 身份只读投影:身份表仍是两张，执行层只读公共字段；不做表合并。

  actor(kind, id) {
    if (kind === 'member') {
      const row = this.get('SELECT * FROM members WHERE id=? AND removed IS NULL', id);
      return row ? { ...row, kind: 'member' } : null;
    }
    if (kind === 'panel_agent') {
      const row = this.get('SELECT * FROM panel_agents WHERE id=?', id);
      return row ? { ...row, kind: 'panel_agent' } : null;
    }
    if (kind === 'external_agent') {
      const row = this.get('SELECT * FROM external_principals WHERE id=?', id);
      return row ? { ...row, kind: 'external_agent' } : null;
    }
    return null;
  }

  actors() {
    const members = this.all('SELECT * FROM members WHERE removed IS NULL ORDER BY rowid').map(row => ({ ...row, kind: 'member' }));
    const panelAgent = this.panelAgent();
    const external = this.all('SELECT * FROM external_principals ORDER BY created').map(row => ({ ...row, kind: 'external_agent' }));
    return [...members, ...(panelAgent ? [{ ...panelAgent, kind: 'panel_agent' }] : []), ...external];
  }
  // 会话列表投影:两种 owner 统一形状；Panel 只有 coordination 会话，私聊不进入团队列表。

  conversationsForGroup(groupId, { includePrivate = false } = {}) {
    const rows = this.all(`SELECT * FROM conversations WHERE 1=1${includePrivate ? '' : " AND context NOT IN ('private','home-summary','archive-summary')"}${groupId === undefined ? '' : ' AND group_id=?'}`,
      ...(groupId === undefined ? [] : [groupId]));
    return rows.map(row => ({ ...row, owner_kind: row.member_id ? 'member' : 'panel_agent', owner_id: row.member_id ?? row.panel_agent_id }));
  }

  setConversationSession(id, session) {
    const changed = this.run('UPDATE conversations SET session=?,updated=? WHERE id=?', session, new Date().toISOString(), id);
    if (!changed.changes) throw new Error('会话不存在');
  }

  setConversationPolicySignature(id, signature, sessionKey = 'default') {
    const changed = this.run('UPDATE conversations SET policy_signature=?,updated=? WHERE id=?', signature, new Date().toISOString(), id);
    if (!changed.changes) throw new Error('会话不存在');
    this.run('INSERT INTO conversation_session_meta(conversation_id,session_key,policy_signature) VALUES(?,?,?) ON CONFLICT(conversation_id,session_key) DO UPDATE SET policy_signature=excluded.policy_signature', id, sessionKey, signature);
  }

  endpoint(memberId, context, peer = null) {
    return this.conversation('member', memberId, context, { peer });
  }

  panelAgent() {
    return this.get('SELECT * FROM panel_agents ORDER BY created LIMIT 1') ?? null;
  }
  // 消息附件查询(纯 DB);availability 由附件模块结合文件现状补充。

  panelAttachments(messageId) {
    return this.all('SELECT id,original_name,media_type,size,storage_name FROM attachments WHERE panel_message_id=? ORDER BY ordinal', messageId);
  }
  // 附件上传设置:空表读取默认值,首次保存 upsert;校验收口在 attachment-settings.mjs。

  attachmentSettings() {
    const row = this.get('SELECT max_file_bytes,max_files,max_image_pixels,updated FROM attachment_settings WHERE singleton=1');
    if (!row) return { ...DEFAULT_ATTACHMENT_SETTINGS, updated: null };
    return serializeAttachmentSettings(row);
  }

  updateAttachmentSettings(value) {
    const settings = normalizeAttachmentSettings(value);
    const now = new Date().toISOString();
    this.run(
      `INSERT INTO attachment_settings(singleton,max_file_bytes,max_files,max_image_pixels,updated) VALUES(1,?,?,?,?)
       ON CONFLICT(singleton) DO UPDATE SET max_file_bytes=excluded.max_file_bytes,max_files=excluded.max_files,max_image_pixels=excluded.max_image_pixels,updated=excluded.updated`,
      settings.maxFileBytes,
      settings.maxFilesPerMessage,
      settings.maxImagePixels,
      now,
    );
    return this.attachmentSettings();
  }

  panelSession(panelAgentId, context, groupId = null) {
    return this.conversation('panel_agent', panelAgentId, context, { groupId });
  }

  authenticatePanelSession(id, key) {
    const conversation = this.get('SELECT * FROM conversations WHERE id=? AND key=? AND panel_agent_id IS NOT NULL', id, key);
    if (!conversation) throw new Error('Panel Agent 会话来源无效');
    const panelAgent = this.get('SELECT * FROM panel_agents WHERE id=?', conversation.panel_agent_id);
    if (!panelAgent) throw new Error('Panel Agent 不存在');
    return { session: { ...conversation, owner_kind: 'panel_agent', owner_id: conversation.panel_agent_id }, panelAgent };
  }

  authenticate(id, key) {
    const conversation = this.get('SELECT * FROM conversations WHERE id=? AND key=? AND member_id IS NOT NULL', id, key);
    if (!conversation) throw new Error('会话来源无效');
    this.member(conversation.member_id);
    return { ...conversation, owner_kind: 'member', owner_id: conversation.member_id };
  }

  append(groupId, sender, recipient, kind, text, replyTo = null, expectsReply = false) {
    this.group(groupId);
    const id = randomUUID();
    // user 收件人不会进入投递队列；note/system 随下一次批量交付，不参与 pending 扫描。
    const awaiting = kind === 'send' && recipient !== 'user' ? 1 : 0;
    const expects = kind === 'send' && expectsReply ? 1 : 0;
    this.run('INSERT INTO messages(id,group_id,sender,recipient,kind,text,reply_to,created,awaiting,expects_reply) VALUES(?,?,?,?,?,?,?,?,?,?)', id, groupId, sender, recipient, kind, text, replyTo, new Date().toISOString(), awaiting, expects);
    return this.get('SELECT * FROM messages WHERE id=?', id);
  }

  dismissWorkbench(category, itemId) {
    this.run('INSERT OR IGNORE INTO workbench_dismissals(category,item_id,created) VALUES(?,?,?)', category, itemId, new Date().toISOString());
  }

  pending() {
    return this.all(`SELECT m.* FROM messages m JOIN groups g ON g.id=m.group_id
      WHERE (g.state IS NULL OR g.state='open') AND m.kind='send' AND m.awaiting=1
      AND (
        EXISTS(SELECT 1 FROM members r WHERE r.id=m.recipient AND r.removed IS NULL)
        OR EXISTS(SELECT 1 FROM team_lead_controllers c WHERE c.group_id=m.group_id AND c.controller_kind='panel_agent' AND c.controller_id=m.recipient AND c.state='active')
        OR EXISTS(SELECT 1 FROM team_lead_controllers c WHERE c.group_id=m.group_id AND c.controller_kind='external_agent' AND c.controller_id=m.recipient AND c.state='active')
      ) ORDER BY m.seq`);
  }
  // 历史保留:删除 cutoff 之前且已可安全丢弃的数据。
  // 保留:待投递消息、待响应互动卡、运行中/待核实回合的输入、Panel 私聊消息与未交付队列。

  pruneHistory({ retentionDays = 30, now = Date.now() } = {}) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error('保留天数无效');
    const cutoff = new Date(now - retentionDays * 86400000).toISOString();
    return this.transaction(() => {
      const messages = this.run(`DELETE FROM messages WHERE created < ? AND awaiting=0
        AND NOT EXISTS(SELECT 1 FROM attached a JOIN outbox o ON o.id=a.outbox_id WHERE a.message_id=messages.id AND o.accepted IS NULL)
        AND NOT EXISTS(SELECT 1 FROM interactions i WHERE i.message_id=messages.id AND i.state='pending')
        AND NOT EXISTS(SELECT 1 FROM external_deliveries d WHERE d.message_id=messages.id AND d.state='pending')
        AND NOT EXISTS(SELECT 1 FROM external_decisions d WHERE d.request_message_id=messages.id AND d.state='pending')
        AND NOT EXISTS(SELECT 1 FROM turn_inputs ti JOIN turns t ON t.id=ti.turn_id WHERE ti.message_id=messages.id AND t.state IN ('running','unknown'))`, cutoff);
      const turns = this.run("DELETE FROM turns WHERE created < ? AND state NOT IN ('running','unknown')", cutoff);
      const history = this.run('DELETE FROM history WHERE created < ? AND (turn_id IS NULL OR turn_id NOT IN (SELECT id FROM turns))', cutoff);
      const outbox = this.run('DELETE FROM outbox WHERE accepted IS NOT NULL AND accepted < ?', cutoff);
      // turn_context_schemas 由 Store schema 统一建表,不再需要存在性嗅探。
      const schemas = this.run('DELETE FROM turn_context_schemas WHERE turn_id NOT IN (SELECT id FROM turns)');
      const dismissals = this.run('DELETE FROM workbench_dismissals WHERE created < ?', cutoff);
      return { messages: messages.changes, turns: turns.changes, history: history.changes, outbox: outbox.changes, schemas: schemas.changes, dismissals: dismissals.changes, cutoff };
    });
  }

  createInteraction({ id, groupId = null, memberId = null, panelAgentId = null, endpointId = null, context, turnId, callId, messageId = null, panelMessageId = null, kind, payload, detail = null }) {
    this.run('INSERT INTO interactions(id,group_id,member_id,panel_agent_id,conversation_id,context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,detail,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, groupId, memberId, panelAgentId, endpointId, context, turnId, callId, messageId, panelMessageId, kind, JSON.stringify(payload), 'pending', detail, new Date().toISOString());
    return this.interaction(id);
  }

  interaction(id) {
    return this.get('SELECT * FROM interactions WHERE id=?', id) ?? null;
  }

  setInteractionState(id, state, answer = null, answerMessageId = null, detail = null) {
    this.run('UPDATE interactions SET state=?,answer=?,detail=?,answer_message_id=?,answered=? WHERE id=?',
      state,
      answer === null ? null : JSON.stringify(answer),
      detail,
      answerMessageId,
      state === 'answered' || state === 'failed' ? new Date().toISOString() : null,
      id);
    return this.interaction(id);
  }

  updateInteractionPayload(id, payload) {
    this.run('UPDATE interactions SET payload=? WHERE id=?', JSON.stringify(payload), id);
    return this.interaction(id);
  }

  interactions(groupId) {
    return this.all('SELECT * FROM interactions WHERE group_id=? ORDER BY created DESC, rowid DESC LIMIT 100', groupId);
  }

  panelInteractions() {
    return this.all('SELECT * FROM interactions WHERE panel_agent_id IS NOT NULL ORDER BY created DESC, rowid DESC LIMIT 100');
  }

  pendingMemberInteractions(groupId, memberId) {
    return this.all("SELECT * FROM interactions WHERE group_id=? AND member_id=? AND state='pending'", groupId, memberId);
  }

  prepare(message, conversation, canBatch = () => true) {
    return this.transaction(() => {
      if (this.get('SELECT 1 FROM attached WHERE message_id=?', message.id)) return null;
      if (conversation.member_id) this.member(conversation.member_id);
      const notes = this.all(`SELECT m.* FROM messages m WHERE m.recipient=? AND m.kind IN ('note','system')
        AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=m.id) ORDER BY m.seq`, message.recipient);
      const candidates = this.all(`SELECT m.* FROM messages m WHERE ${conversation.context === 'coordination' ? '' : 'm.sender=? AND '}m.recipient=? AND m.kind='send' AND m.id!=?
        AND m.awaiting=1 ORDER BY m.seq`, ...(conversation.context === 'coordination' ? [] : [message.sender]), message.recipient, message.id);
      const additional = [];
      for (const candidate of candidates) if (canBatch([message, ...additional, candidate])) additional.push(candidate);
      // 派工引用单独存表,投递时作为消息的附加字段交给成员;不修改 messages 核心表。
      const withStepRef = row => {
        const ref = this.get('SELECT plan_id,step_id FROM message_step_refs WHERE message_id=?', row.id);
        return ref ? { ...row, stepRef: { planId: ref.plan_id, stepId: ref.step_id } } : row;
      };
      const payload = { groupId: message.group_id, conversation: conversation.context === 'coordination' ? 'coordination' : [message.sender, message.recipient].sort(), message: withStepRef(message), ...(additional.length ? { additionalMessages: additional.map(withStepRef) } : {}), notes };
      const id = randomUUID();
      this.run('INSERT INTO outbox(id,conversation_id,payload) VALUES(?,?,?)', id, conversation.id, JSON.stringify(payload));
      for (const item of [message, ...additional, ...notes]) {
        this.run('INSERT INTO attached VALUES(?,?)', item.id, id);
        this.run('UPDATE messages SET awaiting=0 WHERE id=?', item.id);
      }
      return { id, conversation_id: conversation.id, owner_kind: conversation.owner_kind, payload: JSON.stringify(payload), accepted: null, error: null };
    });
  }

  prepareDelivery(conversation, message, canBatch = () => true) {
    return this.prepare(message, conversation, canBatch);
  }
  // 待投递队列的统一读取:v1 仍是两张表,顺序保持"先 Panel 后成员"，与旧 pump 一致。

  pendingDeliveries() {
    // 部分索引覆盖 accepted IS NULL;ORDER BY rowid 会迫使 SQLite 全表扫描,排序放到 JS。
    return this.all(`SELECT o.rowid AS rowid,o.*,c.member_id,c.panel_agent_id FROM outbox o JOIN conversations c ON c.id=o.conversation_id
      WHERE o.accepted IS NULL AND o.error IS NULL`)
      .sort((a, b) => a.rowid - b.rowid)
      .map(row => ({ ...row, owner_kind: row.member_id ? 'member' : 'panel_agent' }));
  }

  hasPendingDelivery(conversationId) {
    return Boolean(this.get('SELECT 1 FROM outbox WHERE conversation_id=? AND accepted IS NULL AND error IS NULL', conversationId));
  }

  setDeliveryAccepted(entry, accepted = new Date().toISOString()) {
    this.run('UPDATE outbox SET accepted=? WHERE id=?', accepted, entry.id);
  }

  setDeliveryError(entry, error) {
    this.run('UPDATE outbox SET error=? WHERE id=?', error, entry.id);
  }

  deliveryAccepted(entry) {
    return this.get('SELECT accepted FROM outbox WHERE id=?', entry.id)?.accepted ?? null;
  }

  panelAppend(panelAgentId, context, role, text, activeTeamId = null) {
    const id = randomUUID();
    this.run(
      'INSERT INTO panel_messages(id,panel_agent_id,context,role,text,active_team_id,created) VALUES(?,?,?,?,?,?,?)',
      id,
      panelAgentId,
      context,
      role,
      text,
      activeTeamId,
      new Date().toISOString(),
    );
    return this.get('SELECT * FROM panel_messages WHERE id=?', id);
  }

  panelHistory(conversationId, event, turnId = null) {
    return Number(this.run(
      'INSERT INTO history(conversation_id,event,created,turn_id) VALUES(?,?,?,?)',
      conversationId,
      JSON.stringify(event),
      new Date().toISOString(),
      turnId,
    ).lastInsertRowid);
  }
  // 回合统一入口:两种执行者都写同一张 turns；调用方只传 owner 类型。

  createTurn(conversation, {
    executorKind,
    executorId = null,
    inputs = [],
    state = 'running',
    activeTeamId = null,
    sourceUserMessageId = null,
  } = {}) {
    return this.transaction(() => {
      const id = randomUUID();
      this.run(
        'INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,active_team_id,source_user_message_id,state,detail,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        id,
        conversation.id,
        executorKind,
        executorId ?? conversation.owner_id ?? conversation.member_id ?? conversation.panel_agent_id,
        conversation.group_id ?? null,
        conversation.session ?? null,
        activeTeamId,
        sourceUserMessageId,
        state,
        null,
        new Date().toISOString(),
      );
      inputs.forEach((message, ordinal) => this.run('INSERT INTO turn_inputs VALUES(?,?,?)', id, message.id, ordinal));
      return id;
    });
  }
  // 状态写点收敛:所有执行者写同一列 turns.state。

  setTurnState(turnId, state, { detail = null, ended = new Date().toISOString() } = {}) {
    this.run('UPDATE turns SET state=?,detail=?,ended=? WHERE id=?', state, detail, ended, turnId);
    return state;
  }

  setTurnSession(turnId, session) {
    this.run('UPDATE turns SET session=? WHERE id=?', session, turnId);
  }
  // 总线重启后的单次恢复:无法证明宿主已停止的回合一律标 unknown，等待用户核实。

  recoverInterruptedTurns() {
    const result = this.run("UPDATE turns SET state='unknown',detail='总线重启，需要用户核实宿主是否已停止' WHERE state='running'");
    return { turns: result.changes };
  }

  history(conversationId, event, turnId = null) {
    const conversation = this.get('SELECT context,member_id FROM conversations WHERE id=?', conversationId);
    if (!conversation || (conversation.member_id && conversation.context === 'private')) return null;
    return Number(this.run('INSERT INTO history(conversation_id,event,created,turn_id) VALUES(?,?,?,?)', conversationId, JSON.stringify(event), new Date().toISOString(), turnId).lastInsertRowid);
  }

  publicTurn(id) {
    return this.get('SELECT t.*,c.group_id,c.member_id,c.context,c.peer FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.context!=\'private\'', id);
  }
  /**
   * 一条消息的产出事件段。
   *
   * 执行轨迹的单位是「消息」而不是「回合」:一个回合里每发出一次消息,都是一段
   * 独立的 思考→模型→tool_call→tool_result 过程。段的右界是该次调用的
   * tool_result(最终回复是回合末尾的 framework.output),左界是上一次产出消息
   * 的调用结束处,因此同回合内多条消息的段互不重叠、也不会重复计入。
   */

  close() { this.db.close(); }

  messageSegment(turnId, callId) { return traceQueries.messageSegment(this, turnId, callId); }
  messageTrace(id, { segment = false } = {}) { return traceQueries.messageTrace(this, id, { segment }); }
  endpointModels(id, after = 0) { return traceQueries.endpointModels(this, id, after); }
  endpointModelSummary(id) { return traceQueries.endpointModelSummary(this, id); }
  turnErrorSummary(turnId) { return traceQueries.turnErrorSummary(this, turnId); }
  turnSummaries(id, { after, limit = 5 } = {}) { return traceQueries.turnSummaries(this, id, { after, limit }); }
  turnTrace(id, after = 0) { return traceQueries.turnTrace(this, id, after); }
}
