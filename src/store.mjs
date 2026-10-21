import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

function modelObservations(rows) {
  return rows.flatMap(row => {
    const event = JSON.parse(row.event);
    return event.type === 'framework.model' ? [{ seq: row.seq, created: row.created, turnId: row.turn_id, ...event }] : [];
  });
}

function latestWith(observations, field, phases) {
  for (const phase of phases) {
    const found = [...observations].reverse().find(observation => observation.phase === phase && observation[field] != null);
    if (found) return { [field]: found[field], phase: found.phase, source: found.source, seq: found.seq, ...(found.turnId ? { turnId: found.turnId } : {}) };
  }
  return null;
}

function deriveCurrentModel(observations) {
  const latest = [...observations].reverse().find(observation => observation.phase !== 'usage' && (observation.model != null || observation.reasoningEffort != null));
  const current = latest?.turnId ? observations.filter(observation => observation.turnId === latest.turnId) : observations;
  return {
    currentModel: latestWith(current, 'model', ['assistant', 'verified', 'session', 'requested']),
    currentReasoningEffort: latestWith(current, 'reasoningEffort', ['verified', 'session', 'requested']),
  };
}

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = resolve(directory);
    this.db = new DatabaseSync(resolve(directory, 'groups.sqlite'));
    chmodSync(resolve(directory, 'groups.sqlite'), 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace TEXT NOT NULL,lead TEXT,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,name TEXT NOT NULL,host TEXT NOT NULL,role TEXT NOT NULL,profile TEXT NOT NULL DEFAULT '',removed TEXT,UNIQUE(group_id,name));
      CREATE TABLE IF NOT EXISTS endpoints(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,context TEXT NOT NULL,peer TEXT,session TEXT,key TEXT NOT NULL,UNIQUE(member_id,context));
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,sender TEXT NOT NULL,recipient TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,reply_to TEXT,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,payload TEXT NOT NULL,accepted TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS attached(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,outbox_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT,endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,event TEXT NOT NULL,created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient,seq);
      CREATE INDEX IF NOT EXISTS history_endpoint ON history(endpoint_id,seq);`);
    for (const [name, definition] of [
      ['model_provider', 'TEXT'],
      ['model', 'TEXT'],
      ['reasoning_effort', 'TEXT'],
    ]) {
      if (!this.all('PRAGMA table_info(members)').some(column => column.name === name)) {
        this.db.exec(`ALTER TABLE members ADD COLUMN ${name} ${definition}`);
      }
    }
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session TEXT,created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS turn_inputs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,PRIMARY KEY(turn_id,message_id));
        CREATE TABLE IF NOT EXISTS native_turn_refs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,ref TEXT NOT NULL,PRIMARY KEY(turn_id,ref));
        CREATE TABLE IF NOT EXISTS message_origins(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,event_seq INTEGER REFERENCES history(seq) ON DELETE SET NULL,call_id TEXT NOT NULL,native_call_id TEXT);`);
      if (!this.all('PRAGMA table_info(history)').some(column => column.name === 'turn_id')) this.db.exec('ALTER TABLE history ADD COLUMN turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE');
      this.db.exec('CREATE INDEX IF NOT EXISTS history_turn ON history(turn_id,seq); CREATE INDEX IF NOT EXISTS inputs_message ON turn_inputs(message_id);');
    });
  }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  group(id) {
    const group = this.get('SELECT * FROM groups WHERE id=?', id);
    if (!group) throw new Error('群不存在');
    return group;
  }
  member(id) {
    const member = this.get('SELECT * FROM members WHERE id=? AND removed IS NULL', id);
    if (!member) throw new Error('成员不存在或已移除');
    return member;
  }
  endpoint(memberId, context, peer = null) {
    const member = this.member(memberId);
    let endpoint = this.get('SELECT * FROM endpoints WHERE member_id=? AND context=?', memberId, context);
    if (!endpoint) {
      const id = randomUUID();
      this.run('INSERT INTO endpoints VALUES(?,?,?,?,?,?,?)', id, member.group_id, member.id, context, peer, null, randomBytes(32).toString('hex'));
      endpoint = this.get('SELECT * FROM endpoints WHERE id=?', id);
    }
    return endpoint;
  }
  authenticate(id, key) {
    const endpoint = this.get('SELECT * FROM endpoints WHERE id=? AND key=?', id, key);
    if (!endpoint) throw new Error('会话来源无效');
    this.member(endpoint.member_id);
    return endpoint;
  }
  append(groupId, sender, recipient, kind, text, replyTo = null) {
    this.group(groupId);
    const id = randomUUID();
    this.run('INSERT INTO messages(id,group_id,sender,recipient,kind,text,reply_to,created) VALUES(?,?,?,?,?,?,?,?)', id, groupId, sender, recipient, kind, text, replyTo, new Date().toISOString());
    return this.get('SELECT * FROM messages WHERE id=?', id);
  }
  pending() {
    return this.all(`SELECT m.* FROM messages m JOIN members r ON r.id=m.recipient JOIN team_state s ON s.group_id=m.group_id
      WHERE (s.phase='active' OR s.phase='closed') AND m.kind='send' AND r.removed IS NULL
      AND NOT EXISTS(SELECT 1 FROM message_dispositions d WHERE d.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=m.id) ORDER BY m.seq`);
  }
  prepare(message, endpoint, canBatch = () => true) {
    return this.transaction(() => {
      if (this.get('SELECT 1 FROM attached WHERE message_id=?', message.id)) return null;
      this.member(endpoint.member_id);
      const notes = this.all(`SELECT m.* FROM messages m WHERE m.recipient=? AND m.kind IN ('note','system')
        AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=m.id) ORDER BY m.seq`, message.recipient);
      const candidates = this.all(`SELECT m.* FROM messages m WHERE ${endpoint.context === 'coordination' ? '' : 'm.sender=? AND '}m.recipient=? AND m.kind='send' AND m.id!=?
        AND NOT EXISTS(SELECT 1 FROM message_dispositions d WHERE d.message_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=m.id) ORDER BY m.seq`, ...(endpoint.context === 'coordination' ? [] : [message.sender]), message.recipient, message.id);
      const additional = [];
      for (const candidate of candidates) {
        if (canBatch([message, ...additional, candidate])) additional.push(candidate);
      }
      const annotate = m => ({ ...m, workItemId: this.get('SELECT work_item_id FROM message_context WHERE message_id=?', m.id)?.work_item_id ?? null });
      const payload = { groupId: message.group_id, conversation: endpoint.context === 'coordination' ? 'coordination' : [message.sender, message.recipient].sort(), message: annotate(message), ...(additional.length ? { additionalMessages: additional.map(annotate) } : {}), notes };
      const id = randomUUID();
      this.run('INSERT INTO outbox(id,endpoint_id,payload) VALUES(?,?,?)', id, endpoint.id, JSON.stringify(payload));
      for (const item of [message, ...additional, ...notes]) this.run('INSERT INTO attached VALUES(?,?)', item.id, id);
      return { id, endpoint_id: endpoint.id, payload: JSON.stringify(payload), accepted: null, error: null };
    });
  }
  createTurn(endpoint, inputs = []) {
    return this.transaction(() => {
      const id = randomUUID();
      this.run('INSERT INTO turns VALUES(?,?,?,?)', id, endpoint.id, endpoint.session, new Date().toISOString());
      inputs.forEach((message, ordinal) => this.run('INSERT INTO turn_inputs VALUES(?,?,?)', id, message.id, ordinal));
      return id;
    });
  }
  history(endpointId, event, turnId = null) {
    const endpoint = this.get('SELECT context FROM endpoints WHERE id=?', endpointId);
    if (endpoint && endpoint.context !== 'private') return Number(this.run('INSERT INTO history(endpoint_id,event,created,turn_id) VALUES(?,?,?,?)', endpointId, JSON.stringify(event), new Date().toISOString(), turnId).lastInsertRowid);
    return null;
  }
  publicTurn(id) {
    return this.get(`SELECT t.*,e.group_id,e.member_id,e.context,e.peer FROM turns t JOIN endpoints e ON e.id=t.endpoint_id WHERE t.id=? AND e.context!='private'`, id);
  }
  messageTrace(id) {
    const message = this.get('SELECT id,kind FROM messages WHERE id=?', id);
    if (!message) return null;
    const origin = this.get(`SELECT o.*,e.context,e.id AS endpoint_id FROM message_origins o JOIN turns t ON t.id=o.turn_id JOIN endpoints e ON e.id=t.endpoint_id WHERE o.message_id=?`, id);
    const source = !origin ? { kind: message.kind === 'system' ? 'system' : 'unknown' } : origin.context === 'private' ? { kind: 'private' } : { kind: 'group', turnId: origin.turn_id, endpointId: origin.endpoint_id, eventSeq: origin.event_seq, callId: origin.call_id, nativeCallId: origin.native_call_id };
    const inputAttempts = this.all(`SELECT t.id,t.endpoint_id,t.session,t.created FROM turn_inputs i JOIN turns t ON t.id=i.turn_id JOIN endpoints e ON e.id=t.endpoint_id WHERE i.message_id=? AND e.context!='private' ORDER BY t.rowid`, id);
    return { messageId: id, source, inputAttempts };
  }
  endpointModels(id, after = 0) {
    const endpoint = this.get("SELECT id FROM endpoints WHERE id=? AND context!='private'", id);
    if (!endpoint) return null;
    const all = modelObservations(this.all('SELECT seq,turn_id,created,event FROM history WHERE endpoint_id=? ORDER BY seq', id));
    const observations = all.filter(observation => observation.seq > after).slice(0, 200);
    return { ...deriveCurrentModel(all), observations, nextAfter: observations.at(-1)?.seq ?? after };
  }
  endpointModelSummary(id) {
    const all = modelObservations(this.all('SELECT seq,turn_id,created,event FROM history WHERE endpoint_id=? ORDER BY seq', id));
    return deriveCurrentModel(all);
  }
  turnTrace(id, after = 0) {
    const turn = this.publicTurn(id);
    if (!turn) return null;
    const events = this.all('SELECT * FROM history WHERE turn_id=? AND seq>? ORDER BY seq LIMIT 200', id, after);
    const observations = modelObservations(this.all('SELECT seq,turn_id,created,event FROM history WHERE turn_id=? ORDER BY seq', id));
    return { turn, nativeTurnRefs: this.all('SELECT ref FROM native_turn_refs WHERE turn_id=? ORDER BY rowid', id).map(row => row.ref),
      inputMessages: this.all('SELECT m.id,m.kind,i.ordinal FROM turn_inputs i JOIN messages m ON m.id=i.message_id WHERE i.turn_id=? ORDER BY i.ordinal', id),
      outgoingMessages: this.all('SELECT message_id,event_seq,call_id,native_call_id FROM message_origins WHERE turn_id=? ORDER BY rowid', id),
      ...deriveCurrentModel(observations), modelObservations: observations,
      events, nextAfter: events.at(-1)?.seq ?? after };
  }
  close() { this.db.close(); }
}
