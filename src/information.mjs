// Deterministic information projection for agent inputs and framework tool
// results. Authority stays in Store; this module only derives views, stable
// references and size measurements.
import { createHash, randomUUID } from 'node:crypto';
import * as messagesAgg from './aggregates/messages.mjs';
import * as conversationsAgg from './aggregates/conversations.mjs';

export const CONTEXT_SCHEMA_VERSION = 2;
export const LEGACY_SCHEMA_VERSION = 0;
export const MESSAGE_REF_UNIT = 'unicode-code-point';
export const MAX_BODY_PAGE = 4096;
export const MAX_MESSAGE_PAGE = 200;

// Defaults are a starting point measured against the local core tests, not a
// claim that every task fits. Callers may pass tighter budgets in tests.
export const DEFAULT_BUDGETS = Object.freeze({
  rulesBytes: 16 * 1024,
  turnInputBytes: 512 * 1024,
  previewCodePoints: 512,
});

const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const now = () => new Date().toISOString();

export function byteSize(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : json(value));
}
export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex');
}
export function codePointLength(text) {
  return Array.from(text).length;
}
export function clampInt(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function messageRef(row) {
  return { id: row.id, hash: contentHash(row.text), length: codePointLength(row.text), unit: MESSAGE_REF_UNIT };
}

export function boundedMessage(row, { previewCodePoints = DEFAULT_BUDGETS.previewCodePoints } = {}) {
  const points = Array.from(row.text);
  const preview = points.slice(0, previewCodePoints).join('');
  return {
    id: row.id,
    seq: row.seq,
    sender: row.sender,
    recipient: row.recipient,
    kind: row.kind,
    replyTo: row.reply_to ?? null,
    expectsReply: Boolean(row.expects_reply),
    created: row.created,
    ref: { id: row.id, hash: contentHash(row.text), length: points.length, unit: MESSAGE_REF_UNIT },
    preview,
    complete: points.length <= previewCodePoints,
  };
}

export function boundedMessages(rows, { limit = 50, after = 0, previewCodePoints = DEFAULT_BUDGETS.previewCodePoints } = {}) {
  const delivered = rows.slice(0, limit);
  return {
    schema: CONTEXT_SCHEMA_VERSION,
    view: 'bounded',
    unit: MESSAGE_REF_UNIT,
    messages: delivered.map(row => boundedMessage(row, { previewCodePoints })),
    nextAfter: delivered.at(-1)?.seq ?? after,
    hasMore: rows.length > limit,
    complete: rows.length <= limit,
  };
}

export function expandMessageText(row, { hash, offset = 0, bodyLimit = 1024, schema = CONTEXT_SCHEMA_VERSION } = {}) {
  if (typeof hash !== 'string' || !hash.trim()) throw new Error('正文引用缺少内容哈希，不能证明读取的是同一内容');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('无效的正文偏移');
  if (!Number.isInteger(bodyLimit) || bodyLimit < 1 || bodyLimit > MAX_BODY_PAGE) throw new Error('无效的正文范围');
  if (contentHash(row.text) !== hash) throw new Error('正文引用内容已变化（stale），请重新读取消息列表');
  const points = Array.from(row.text);
  if (offset > points.length) throw new Error('正文偏移超出内容长度');
  const end = Math.min(offset + bodyLimit, points.length);
  return {
    schema,
    view: 'body',
    unit: MESSAGE_REF_UNIT,
    ref: { id: row.id, hash, length: points.length, unit: MESSAGE_REF_UNIT },
    text: points.slice(offset, end).join(''),
    offset,
    next: end,
    hasMore: end < points.length,
    complete: end === points.length,
  };
}

function fullInputMessage(row) {
  return {
    id: row.id,
    seq: row.seq,
    sender: row.sender,
    recipient: row.recipient,
    kind: row.kind,
    replyTo: row.reply_to ?? null,
    expectsReply: Boolean(row.expects_reply),
    created: row.created,
    ref: messageRef(row),
    text: row.text,
    complete: true,
  };
}

// Turn input: fixed rules live apart; this object is the authoritative dynamic
// facts for the round. Current task material is delivered in full, never as a
// preview.
export function projectTurnInput({
  group,
  charter,
  policy,
  input,
  schema = CONTEXT_SCHEMA_VERSION,
  awaitingReceipt,
} = {}) {
  const view = {
    contextSchemaVersion: schema,
    schema,
    group: { id: group.id, name: group.name },
    charter: charter ?? null,
    policy,
    input: {
      message: fullInputMessage(input.message),
      additionalMessages: (input.additionalMessages ?? []).map(row => fullInputMessage(row)),
      notes: (input.notes ?? []).map(row => fullInputMessage(row)),
    },
  };
  // 用户请求的未回执状态进回合输入:主控凭可见状态行动,不凭跨回合记忆;
  // 回执一旦发布,查询自然为空,字段随之消失。
  if (awaitingReceipt?.length) view.awaitingReceipt = awaitingReceipt;
  const budget = DEFAULT_BUDGETS.turnInputBytes;
  if (byteSize(view) > budget) {
    throw new Error(`本轮输入超过 ${budget} 字节预算：触发消息不会被静默截断；请缩减触发消息或改用 read 分页读取历史`);
  }
  return view;
}

export class Information {
  constructor(store, { budgets = {} } = {}) {
    this.store = store;
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
    this.migrate();
  }

  migrate() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS information_measurements(
        id TEXT PRIMARY KEY,
        group_id TEXT,
        endpoint_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        detail TEXT NOT NULL,
        created TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS information_measurements_turn ON information_measurements(turn_id,kind);
      CREATE INDEX IF NOT EXISTS information_measurements_group ON information_measurements(group_id,created);
      CREATE TABLE IF NOT EXISTS turn_context_schemas(
        turn_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        session_key TEXT,
        created TEXT NOT NULL
      );
    `);
  }

  // --- context schema compatibility -------------------------------------

  memberSchemaForSession(endpoint, sessionKey, existingSession) {
    const row = conversationsAgg.contextFormat(this.store, endpoint.id, sessionKey);
    if (row?.schema_version != null) return row.schema_version;
    const schema = existingSession ? LEGACY_SCHEMA_VERSION : CONTEXT_SCHEMA_VERSION;
    conversationsAgg.saveContextFormat(this.store, endpoint.id, sessionKey, {
      schemaVersion: schema,
      source: existingSession ? 'legacy-detected' : 'new-session',
    });
    return schema;
  }

  memberSchemaForEndpoint(endpointId) {
    return conversationsAgg.latestSchemaForConversation(this.store, endpointId) ?? LEGACY_SCHEMA_VERSION;
  }

  memberSchemaForTurn(turnId) {
    if (!turnId) return null;
    return this.store.get(
      "SELECT schema_version FROM turn_context_schemas WHERE turn_id=? AND scope='member'",
      turnId,
    )?.schema_version ?? null;
  }

  rememberTurnSchema(turnId, scope, schemaVersion, sessionKey = null) {
    this.store.run(
      'INSERT OR REPLACE INTO turn_context_schemas VALUES(?,?,?,?,?)',
      turnId,
      scope,
      schemaVersion,
      sessionKey,
      now(),
    );
    return schemaVersion;
  }

  toolSchema(turnId, endpointId) {
    return this.memberSchemaForTurn(turnId) ?? this.memberSchemaForEndpoint(endpointId);
  }

  panelSchemaForStart(session) {
    const row = conversationsAgg.contextFormat(this.store, session.id, 'default');
    if (row?.schema_version != null) return row.schema_version;
    return session.session ? LEGACY_SCHEMA_VERSION : CONTEXT_SCHEMA_VERSION;
  }

  rememberPanelSchema(session, schema) {
    const existing = conversationsAgg.contextFormat(this.store, session.id, 'default');
    if (existing?.schema_version == null) {
      conversationsAgg.saveContextFormat(this.store, session.id, 'default', {
        schemaVersion: schema,
        source: schema === CONTEXT_SCHEMA_VERSION ? 'new-session' : 'legacy-detected',
      });
    }
    session.context_schema = existing?.schema_version ?? schema;
    return session.context_schema;
  }

  panelSchemaForTurn(turnId) {
    if (!turnId) return null;
    return this.store.get(
      "SELECT schema_version FROM turn_context_schemas WHERE turn_id=? AND scope='panel'",
      turnId,
    )?.schema_version ?? null;
  }

  panelSchemaForSession(session) {
    return conversationsAgg.contextFormat(this.store, session.id, 'default')?.schema_version ?? LEGACY_SCHEMA_VERSION;
  }

  forgetSessionFormats(endpointId, sessionKey = null) {
    // v7 起格式与会话绑定同表;调用方(resetSession)本就同步删除三者,整行删除语义一致。
    conversationsAgg.forgetContextFormats(this.store, endpointId, sessionKey);
  }

  pruneOrphanTurnSchemas() {
    this.store.run(
      'DELETE FROM turn_context_schemas WHERE turn_id NOT IN (SELECT id FROM turns)',
    );
  }

  // --- message views -----------------------------------------------------

  listMessages({ groupId, after = 0, limit = 50, senderId = null, schema = CONTEXT_SCHEMA_VERSION }) {
    const cap = clampInt(Number.isInteger(limit) ? limit : 50, 1, MAX_MESSAGE_PAGE);
    const params = [groupId, after];
    let where = 'm.group_id=? AND m.seq>?';
    if (senderId) { where += ' AND m.sender=?'; params.push(senderId); }
    params.push(cap + 1);
    const rows = this.store.all(
      `SELECT m.* FROM messages m WHERE ${where} ORDER BY m.seq LIMIT ?`,
      ...params,
    );
    const delivered = rows.slice(0, cap);
    if (schema !== CONTEXT_SCHEMA_VERSION) {
      return { messages: delivered, nextAfter: delivered.at(-1)?.seq ?? after };
    }
    return boundedMessages(rows, {
      limit: cap,
      after,
      previewCodePoints: this.budgets.previewCodePoints,
    });
  }

  readBody({ groupId, messageId, hash, offset = 0, bodyLimit = 1024, schema = CONTEXT_SCHEMA_VERSION }) {
    if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('缺少正文消息ID');
    const row = messagesAgg.byIdInGroup(this.store, messageId, groupId);
    if (!row) throw new Error('消息不存在、已被删除或不属于当前团队');
    return expandMessageText(row, { hash, offset, bodyLimit, schema });
  }

  turnInput({ group, charter, policy, input, schema = CONTEXT_SCHEMA_VERSION, awaitingReceipt }) {
    return projectTurnInput({ group, charter, policy, input, schema, awaitingReceipt });
  }

  // --- measurement (metadata only; never message bodies) -----------------

  measure({ groupId = null, endpointId, turnId = null, kind, schemaVersion = CONTEXT_SCHEMA_VERSION, bytes, detail = {} }) {
    this.store.run(
      `INSERT INTO information_measurements
       (id,group_id,endpoint_id,turn_id,kind,schema_version,bytes,detail,created)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      randomUUID(),
      groupId,
      endpointId,
      turnId,
      kind,
      schemaVersion,
      Math.max(0, Math.round(bytes)),
      json(detail),
      now(),
    );
  }

  ruleBudgetExceeded(instructions, schemaVersion = CONTEXT_SCHEMA_VERSION) {
    return schemaVersion === CONTEXT_SCHEMA_VERSION && byteSize(instructions) > this.budgets.rulesBytes;
  }

  assertRuleBudget(instructions, schemaVersion = CONTEXT_SCHEMA_VERSION) {
    if (!this.ruleBudgetExceeded(instructions, schemaVersion)) return;
    throw new Error(`固定规则超过 ${this.budgets.rulesBytes} 字节预算；规则不会被截断，请缩小规则或调整预算`);
  }

  measureRules({ groupId, endpointId, turnId, schemaVersion, instructions, fixed }) {
    const bytes = byteSize(instructions);
    this.measure({
      groupId,
      endpointId,
      turnId,
      kind: 'rules',
      schemaVersion,
      bytes,
      detail: { fixed: fixed === true, overBudget: this.ruleBudgetExceeded(instructions, schemaVersion) },
    });
  }

  measureTurnInput({ groupId, endpointId, turnId, schemaVersion, prompt }) {
    this.measure({ groupId, endpointId, turnId, kind: 'turn_input', schemaVersion, bytes: byteSize(prompt), detail: {} });
  }

  measureToolResult({ groupId, endpointId, turnId, schemaVersion, name, result, detail = {} }) {
    const bytes = byteSize(result);
    this.measure({ groupId, endpointId, turnId, kind: 'tool_result', schemaVersion, bytes, detail: { name, ...detail } });
    return { bytes };
  }

  manifest(turnId) {
    const rows = this.store.all(
      `SELECT kind,schema_version,bytes,detail,created
       FROM information_measurements WHERE turn_id=? ORDER BY created,rowid`,
      turnId,
    ).map(row => ({ ...row, detail: parse(row.detail) }));
    const sum = kind => rows.filter(row => row.kind === kind).reduce((total, row) => total + row.bytes, 0);
    return {
      turnId,
      schemaVersions: [...new Set(rows.map(row => row.schema_version))],
      rulesBytes: sum('rules'),
      turnInputBytes: sum('turn_input'),
      toolResultBytes: sum('tool_result'),
      toolCalls: rows.filter(row => row.kind === 'tool_result').length,
      expandCount: rows.filter(row => row.kind === 'tool_result' && row.detail.expansion === true).length,
      measurements: rows,
    };
  }
}
