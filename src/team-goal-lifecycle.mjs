import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { validateContract } from './collaboration.mjs';

const now = () => new Date().toISOString();
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const digest = value => createHash('sha256').update(json(value)).digest('hex');

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 48000) {
    throw new Error(`${name}需要非空文本`);
  }
  return value.trim();
}

function uniqueStrings(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name}必须是字符串数组`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

export class TeamGoalLifecycle {
  constructor(store) {
    this.store = store;
    this.ensureSchema();
    this.backfillLegacyGoals();
  }

  ensureSchema() {
    const groupColumns = new Set(this.store.all('PRAGMA table_info(groups)').map(column => column.name));
    if (!groupColumns.has('state')) this.store.db.exec("ALTER TABLE groups ADD COLUMN state TEXT NOT NULL DEFAULT 'open'");
    if (!groupColumns.has('revision')) this.store.db.exec('ALTER TABLE groups ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS team_charter_versions(
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        hash TEXT NOT NULL,
        approval TEXT NOT NULL,
        created TEXT NOT NULL,
        PRIMARY KEY(group_id,version)
      );
      CREATE TABLE IF NOT EXISTS goal_drafts(
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        body TEXT NOT NULL,
        hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('draft','confirmed','deleted')),
        goal_id TEXT,
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goals(
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','active','finalizing','completed','terminated','cancelled')),
        queue_position INTEGER,
        revision INTEGER NOT NULL DEFAULT 1,
        cutoff_seq INTEGER,
        outcome TEXT,
        final TEXT,
        finish_reason TEXT,
        origin_draft_id TEXT,
        created TEXT NOT NULL,
        started TEXT,
        ended TEXT,
        UNIQUE(group_id,number)
      );
      CREATE TABLE IF NOT EXISTS goal_contract_versions(
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        hash TEXT NOT NULL,
        approval TEXT NOT NULL,
        created TEXT NOT NULL,
        PRIMARY KEY(goal_id,version)
      );
      CREATE TABLE IF NOT EXISTS goal_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        goal_id TEXT,
        draft_id TEXT,
        type TEXT NOT NULL,
        body TEXT NOT NULL,
        created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_goal_operations(
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        hash TEXT NOT NULL,
        result TEXT NOT NULL,
        created TEXT NOT NULL,
        PRIMARY KEY(group_id,id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS goals_one_current
        ON goals(group_id) WHERE state IN ('active','finalizing');
      CREATE UNIQUE INDEX IF NOT EXISTS goals_unique_queue_position
        ON goals(group_id,queue_position) WHERE state='queued';
      CREATE INDEX IF NOT EXISTS goal_drafts_team ON goal_drafts(group_id,state);
      CREATE INDEX IF NOT EXISTS goal_events_team ON goal_events(group_id,seq);
    `);
    const ensureColumn = (table, name, definition) => {
      if (!this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)) return;
      if (!this.store.all(`PRAGMA table_info(${table})`).some(column => column.name === name)) {
        this.store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    for (const table of ['work_items', 'work_records', 'user_outputs', 'runtime_attempts', 'message_context']) {
      ensureColumn(table, 'goal_id', 'TEXT');
    }
    for (const [table, index] of [
      ['work_items', 'work_items_goal'],
      ['work_records', 'work_records_goal'],
      ['user_outputs', 'user_outputs_goal'],
      ['runtime_attempts', 'runtime_attempts_goal'],
      ['message_context', 'message_context_goal'],
    ]) {
      if (this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)) {
        this.store.db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(goal_id)`);
      }
    }
  }

  backfillLegacyGoals(teamId = null) {
    const table = name => this.store.get(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
      name,
    );
    if (!table('team_state') || !table('contract_versions')) return;
    const rows = teamId
      ? this.store.all('SELECT * FROM team_state WHERE group_id=?', teamId)
      : this.store.all('SELECT * FROM team_state ORDER BY group_id');
    for (const state of rows) {
      let goalState;
      if (state.phase === 'active') goalState = 'active';
      else if (state.phase === 'closing') goalState = 'finalizing';
      else if (state.phase === 'closed') {
        goalState = state.outcome === 'completed' ? 'completed' : 'terminated';
      } else continue;
      const stale = this.store.all(
        `SELECT * FROM goals
         WHERE group_id=? AND number<>? AND state IN ('active','finalizing')`,
        state.group_id,
        state.goal_version,
      );
      for (const goal of stale) {
        const completed = this.store.get(
          'SELECT 1 FROM user_outputs WHERE group_id=? AND (goal_id=? OR goal_version=?) LIMIT 1',
          state.group_id,
          goal.id,
          goal.number,
        );
        this.store.run(
          `UPDATE goals
           SET state=?,queue_position=NULL,revision=revision+1,outcome=?,ended=?
           WHERE id=?`,
          completed ? 'completed' : 'terminated',
          completed ? 'completed' : 'incomplete',
          now(),
          goal.id,
        );
        this.event(state.group_id, goal.id, null, 'goal.legacy_synchronized', {
          state: completed ? 'completed' : 'terminated',
        });
      }
      const existing = this.store.get(
        'SELECT 1 FROM goals WHERE group_id=? AND number=?',
        state.group_id,
        state.goal_version,
      );
      if (existing) {
        this.store.run(
          `UPDATE goals
           SET state=?,
               cutoff_seq=CASE WHEN ?='finalizing'
                 THEN COALESCE(cutoff_seq,(SELECT COALESCE(MAX(seq),0) FROM messages WHERE group_id=?))
                 ELSE NULL END,
               outcome=?,final=?,finish_reason=?,
               ended=CASE WHEN ? IN ('completed','terminated','cancelled') THEN COALESCE(ended,?) ELSE NULL END
           WHERE group_id=? AND number=?`,
          goalState,
          goalState,
          state.group_id,
          state.outcome ?? null,
          state.final ?? null,
          state.finish_reason ?? null,
          goalState,
          now(),
          state.group_id,
          state.goal_version,
        );
        continue;
      }
      const contract = this.store.get(
        'SELECT * FROM contract_versions WHERE group_id=? AND version=?',
        state.group_id,
        state.contract_version,
      );
      if (!contract) continue;
      const id = `legacy-${digest({ groupId: state.group_id, number: state.goal_version }).slice(0, 32)}`;
      const body = {
        contract: parse(contract.body),
        requirements: { requiredMemberIds: [] },
      };
      const created = now();
      this.store.run(
        `INSERT INTO goals(
          id,group_id,number,state,queue_position,revision,cutoff_seq,outcome,final,
          finish_reason,origin_draft_id,created,started,ended
        ) VALUES(?,?,?,?,NULL,1,NULL,?,?,?,NULL,?,?,?)`,
        id,
        state.group_id,
        state.goal_version,
        goalState,
        state.outcome ?? null,
        state.final ?? null,
        state.finish_reason ?? null,
        created,
        goalState === 'queued' ? null : created,
        ['completed', 'terminated', 'cancelled'].includes(goalState) ? created : null,
      );
      this.store.run(
        `INSERT INTO goal_contract_versions(goal_id,version,body,hash,approval,created)
         VALUES(?,?,?,?,?,?)`,
        id,
        1,
        json(body),
        digest(body),
        contract.approval,
        created,
      );
      this.event(state.group_id, id, null, 'goal.migrated_from_team_state', {
        oldPhase: state.phase,
        oldOutcome: state.outcome,
      });
    }
    for (const goal of this.store.all('SELECT * FROM goals ORDER BY group_id,number')) {
      this.store.run(
        'UPDATE work_items SET goal_id=? WHERE group_id=? AND goal_version=?',
        goal.id,
        goal.group_id,
        goal.number,
      );
      this.store.run(
        'UPDATE work_records SET goal_id=? WHERE group_id=? AND goal_version=?',
        goal.id,
        goal.group_id,
        goal.number,
      );
      this.store.run(
        'UPDATE user_outputs SET goal_id=? WHERE group_id=? AND goal_version=?',
        goal.id,
        goal.group_id,
        goal.number,
      );
    }
    if (table('work_items')) {
      this.store.run(`
        UPDATE message_context
        SET goal_id=(SELECT goal_id FROM work_items WHERE work_items.id=message_context.work_item_id)
        WHERE goal_id IS NULL AND work_item_id IS NOT NULL
      `);
    }
    this.store.run(`
      UPDATE message_context
      SET goal_id=(
        SELECT goals.id
        FROM goals
        JOIN goal_contract_versions ON goal_contract_versions.goal_id=goals.id
        WHERE goals.group_id=(
          SELECT messages.group_id FROM messages WHERE messages.id=message_context.message_id
        ) AND goal_contract_versions.version=message_context.contract_version
        ORDER BY goals.number DESC
        LIMIT 1
      )
      WHERE goal_id IS NULL
    `);
    this.store.run(`
      UPDATE runtime_attempts
      SET goal_id=(
        SELECT goals.id
        FROM goals
        JOIN goal_contract_versions ON goal_contract_versions.goal_id=goals.id
        WHERE goals.group_id=runtime_attempts.group_id
          AND goal_contract_versions.version=runtime_attempts.contract_version
        ORDER BY goals.number DESC
        LIMIT 1
      )
      WHERE goal_id IS NULL
    `);
  }

  syncLegacyTeam(teamId) {
    this.store.group(teamId);
    this.backfillLegacyGoals(teamId);
    return this.read(teamId);
  }

  read(teamId) {
    const team = this.store.group(teamId);
    const drafts = this.store.all(
      "SELECT * FROM goal_drafts WHERE group_id=? AND state='draft' ORDER BY rowid",
      teamId,
    ).map(row => this.draftView(row));
    const current = this.store.get(
      "SELECT * FROM goals WHERE group_id=? AND state IN ('active','finalizing')",
      teamId,
    );
    const queue = this.queueViews(teamId);
    const history = this.store.all(
      "SELECT * FROM goals WHERE group_id=? AND state IN ('completed','terminated','cancelled') ORDER BY number",
      teamId,
    ).map(row => this.goalView(row));
    return {
      team: {
        id: team.id,
        name: team.name,
        workspace: team.workspace,
        state: team.state ?? 'open',
        revision: team.revision ?? 1,
      },
      current: current ? this.goalView(current) : null,
      drafts,
      queue,
      history,
    };
  }

  apply(teamId, actor, command, expectedRevision, operationId) {
    text(operationId, 'operationId');
    const commandHash = digest({ teamId, actor, command });
    return this.store.transaction(() => {
      const prior = this.store.get(
        'SELECT hash,result FROM team_goal_operations WHERE group_id=? AND id=?',
        teamId,
        operationId,
      );
      if (prior) {
        if (prior.hash !== commandHash) throw new Error('同一operationId不能用于不同命令');
        return parse(prior.result);
      }
      const team = this.store.group(teamId);
      const revision = team.revision ?? 1;
      if (revision !== expectedRevision) {
        throw new Error(`Team状态版本冲突，当前revision=${revision}，请重新读取`);
      }
      let result;
      if (!['team.archive', 'team.restore'].includes(command?.type)) this.requireOpen(teamId);
      if (command?.type === 'draft.create') {
        this.requireMain(teamId, actor);
        result = this.createDraft(teamId, command);
      } else if (command?.type === 'draft.update') {
        this.requireMain(teamId, actor);
        result = this.updateDraft(teamId, command);
      } else if (command?.type === 'draft.delete') {
        this.requireUser(actor);
        result = this.deleteDraft(teamId, command);
      } else if (command?.type === 'draft.confirm') {
        this.requireUser(actor);
        result = this.confirmDraft(teamId, command);
      } else if (command?.type === 'queue.reorder') {
        this.requireUser(actor);
        result = this.reorderQueue(teamId, command);
      } else if (command?.type === 'queue.cancel') {
        this.requireUser(actor);
        result = this.cancelQueuedGoal(teamId, command);
      } else if (command?.type === 'goal.terminate') {
        this.requireUser(actor);
        result = this.terminateGoal(teamId, command);
      } else if (command?.type === 'goal.finish-request') {
        this.requireMain(teamId, actor);
        result = this.requestGoalFinish(teamId, command);
      } else if (command?.type === 'goal.finish-withdraw') {
        this.requireMain(teamId, actor);
        result = this.withdrawGoalFinish(teamId, command);
      } else if (command?.type === 'team.archive') {
        this.requireUser(actor);
        result = this.archiveTeam(teamId);
      } else if (command?.type === 'team.restore') {
        this.requireUser(actor);
        result = this.restoreTeam(teamId);
      } else {
        throw new Error(`不支持的生命周期命令: ${command?.type ?? ''}`);
      }
      const next = revision + 1;
      this.store.run('UPDATE groups SET revision=? WHERE id=?', next, teamId);
      const output = {
        ...result,
        revision: next,
        ...(result.team ? { team: { ...result.team, revision: next } } : {}),
      };
      this.store.run(
        'INSERT INTO team_goal_operations(group_id,id,hash,result,created) VALUES(?,?,?,?,?)',
        teamId,
        operationId,
        commandHash,
        json(output),
        now(),
      );
      return output;
    });
  }

  advance(teamId) {
    this.store.group(teamId);
    return this.store.transaction(() => {
      const team = this.store.group(teamId);
      const before = team.revision ?? 1;
      const activated = this.activateNextEligible(teamId);
      if (!activated) return { activated: null, revision: before };
      const revision = before + 1;
      this.store.run('UPDATE groups SET revision=? WHERE id=?', revision, teamId);
      return { activated: this.goalView(activated), revision };
    });
  }

  createDraft(teamId, command) {
    const contract = validateContract(command.contract);
    const requiredMemberIds = uniqueStrings(
      command.requirements?.requiredMemberIds,
      'requiredMemberIds',
    );
    for (const memberId of requiredMemberIds) {
      const member = this.store.get(
        'SELECT id FROM members WHERE id=? AND group_id=? AND removed IS NULL',
        memberId,
        teamId,
      );
      if (!member) throw new Error(`Goal Draft引用了不存在的成员: ${memberId}`);
    }
    const body = { contract, requirements: { requiredMemberIds } };
    const id = randomUUID();
    const created = now();
    const hash = digest(body);
    this.store.run(
      `INSERT INTO goal_drafts(id,group_id,revision,body,hash,state,goal_id,created,updated)
       VALUES(?,?,?,?,?,'draft',NULL,?,?)`,
      id,
      teamId,
      '1',
      json(body),
      hash,
      created,
      created,
    );
    this.event(teamId, null, id, 'goal_draft.created', { revision: 1, hash });
    return {
      draft: this.draftView(this.store.get('SELECT * FROM goal_drafts WHERE id=?', id)),
    };
  }

  updateDraft(teamId, command) {
    const draftId = text(command.draftId, 'draftId');
    const draft = this.store.get(
      'SELECT * FROM goal_drafts WHERE id=? AND group_id=?',
      draftId,
      teamId,
    );
    if (!draft) throw new Error('Goal Draft不存在');
    if (draft.state !== 'draft') throw new Error('Goal Draft已经确认或删除');
    if (draft.revision !== command.draftRevision) throw new Error('Goal Draft版本冲突');
    const contract = validateContract(command.contract);
    const requiredMemberIds = uniqueStrings(
      command.requirements?.requiredMemberIds,
      'requiredMemberIds',
    );
    for (const memberId of requiredMemberIds) {
      const member = this.store.get(
        'SELECT id FROM members WHERE id=? AND group_id=? AND removed IS NULL',
        memberId,
        teamId,
      );
      if (!member) throw new Error(`Goal Draft引用了不存在的成员: ${memberId}`);
    }
    const body = { contract, requirements: { requiredMemberIds } };
    const revision = draft.revision + 1;
    const hash = digest(body);
    this.store.run(
      "UPDATE goal_drafts SET revision=?,body=?,hash=?,updated=? WHERE id=? AND state='draft'",
      revision,
      json(body),
      hash,
      now(),
      draft.id,
    );
    this.event(teamId, null, draft.id, 'goal_draft.updated', { revision, hash });
    return {
      draft: this.draftView(this.store.get('SELECT * FROM goal_drafts WHERE id=?', draft.id)),
    };
  }

  deleteDraft(teamId, command) {
    const draftId = text(command.draftId, 'draftId');
    const draft = this.store.get(
      'SELECT * FROM goal_drafts WHERE id=? AND group_id=?',
      draftId,
      teamId,
    );
    if (!draft) throw new Error('Goal Draft不存在');
    if (draft.state !== 'draft') throw new Error('Goal Draft已经确认或删除');
    if (draft.revision !== command.draftRevision) throw new Error('Goal Draft版本冲突');
    const updated = now();
    this.store.run(
      "UPDATE goal_drafts SET state='deleted',updated=? WHERE id=? AND state='draft'",
      updated,
      draft.id,
    );
    this.event(teamId, null, draft.id, 'goal_draft.deleted', { revision: draft.revision });
    return {
      draft: this.draftView(this.store.get('SELECT * FROM goal_drafts WHERE id=?', draft.id)),
    };
  }

  reorderQueue(teamId, command) {
    const ordered = uniqueStrings(command.orderedGoalIds, 'orderedGoalIds');
    const queued = this.store.all(
      "SELECT id,rowid FROM goals WHERE group_id=? AND state='queued' ORDER BY queue_position,number",
      teamId,
    );
    const current = new Set(queued.map(goal => goal.id));
    if (ordered.length !== queued.length || ordered.some(id => !current.has(id))) {
      throw new Error('队列排序必须完整包含当前所有Queued Goal');
    }
    for (const goal of queued) {
      this.store.run(
        'UPDATE goals SET queue_position=? WHERE id=?',
        -goal.rowid,
        goal.id,
      );
    }
    ordered.forEach((goalId, index) => {
      this.store.run(
        'UPDATE goals SET queue_position=?,revision=revision+1 WHERE id=?',
        index + 1,
        goalId,
      );
    });
    this.event(teamId, null, null, 'goal_queue.reordered', { orderedGoalIds: ordered });
    return { queue: this.queueViews(teamId) };
  }

  cancelQueuedGoal(teamId, command) {
    const reason = text(command.reason, '取消原因');
    const goal = this.store.get(
      "SELECT * FROM goals WHERE id=? AND group_id=? AND state='queued'",
      command.goalId,
      teamId,
    );
    if (!goal) throw new Error('Queued Goal不存在');
    this.store.run(
      "UPDATE goals SET state='cancelled',queue_position=NULL,revision=revision+1,finish_reason=?,ended=? WHERE id=?",
      reason,
      now(),
      goal.id,
    );
    this.event(teamId, goal.id, null, 'goal.cancelled', { reason });
    return {
      goal: this.goalView(this.store.get('SELECT * FROM goals WHERE id=?', goal.id)),
      queue: this.queueViews(teamId),
    };
  }

  terminateGoal(teamId, command) {
    const reason = text(command.reason, '终止原因');
    const goal = this.store.get(
      `SELECT * FROM goals
       WHERE id=? AND group_id=? AND state IN ('active','finalizing')`,
      command.goalId,
      teamId,
    );
    if (!goal) throw new Error('Current Goal不存在');
    this.store.run(
      `UPDATE goals
       SET state='terminated',revision=revision+1,outcome='incomplete',
           finish_reason=?,ended=?
       WHERE id=?`,
      reason,
      now(),
      goal.id,
    );
    this.event(teamId, goal.id, null, 'goal.terminated', { reason });
    this.activateNextEligible(teamId);
    return {
      goal: this.goalView(this.store.get('SELECT * FROM goals WHERE id=?', goal.id)),
      current: this.currentGoalView(teamId),
      queue: this.queueViews(teamId),
    };
  }

  requestGoalFinish(teamId, command) {
    const goal = this.store.get(
      "SELECT * FROM goals WHERE id=? AND group_id=? AND state='active'",
      command.goalId,
      teamId,
    );
    if (!goal) throw new Error('Current Goal不存在或不能收尾');
    const cutoff = this.store.get(
      'SELECT COALESCE(MAX(seq),0) AS value FROM messages WHERE group_id=?',
      teamId,
    ).value;
    this.store.run(
      "UPDATE goals SET state='finalizing',cutoff_seq=?,revision=revision+1 WHERE id=?",
      cutoff,
      goal.id,
    );
    this.event(teamId, goal.id, null, 'goal.finish_requested', { cutoffSeq: cutoff });
    return {
      current: this.currentGoalView(teamId),
      queue: this.queueViews(teamId),
    };
  }

  withdrawGoalFinish(teamId, command) {
    const reason = text(command.reason, '撤回收尾原因');
    const goal = this.store.get(
      "SELECT * FROM goals WHERE id=? AND group_id=? AND state='finalizing'",
      command.goalId,
      teamId,
    );
    if (!goal) throw new Error('Goal不在收尾状态');
    this.store.run(
      "UPDATE goals SET state='active',cutoff_seq=NULL,revision=revision+1 WHERE id=?",
      goal.id,
    );
    this.event(teamId, goal.id, null, 'goal.finish_withdrawn', { reason });
    return {
      current: this.currentGoalView(teamId),
      queue: this.queueViews(teamId),
    };
  }

  archiveTeam(teamId) {
    const team = this.store.group(teamId);
    if ((team.state ?? 'open') !== 'open') throw new Error('Team已经归档');
    if (this.store.get(
      "SELECT 1 FROM goals WHERE group_id=? AND state IN ('active','finalizing')",
      teamId,
    )) {
      throw new Error('存在Current Goal，不能归档Team');
    }
    this.store.run("UPDATE groups SET state='archived' WHERE id=?", teamId);
    this.event(teamId, null, null, 'team.archived', {});
    return this.read(teamId);
  }

  restoreTeam(teamId) {
    const team = this.store.group(teamId);
    if ((team.state ?? 'open') !== 'archived') throw new Error('Team未归档');
    this.store.run("UPDATE groups SET state='open' WHERE id=?", teamId);
    this.event(teamId, null, null, 'team.restored', {});
    this.activateNextEligible(teamId);
    return this.read(teamId);
  }

  confirmDraft(teamId, command) {
    const draftId = text(command.draftId, 'draftId');
    const draft = this.store.get(
      'SELECT * FROM goal_drafts WHERE id=? AND group_id=?',
      draftId,
      teamId,
    );
    if (!draft) throw new Error('Goal Draft不存在');
    if (draft.state !== 'draft') throw new Error('Goal Draft已经确认或删除');
    if (draft.revision !== command.draftRevision) throw new Error('Goal Draft版本冲突');
    if (draft.hash !== command.hash) throw new Error('Goal Draft hash不匹配');

    const number = this.store.get(
      'SELECT COALESCE(MAX(number),0)+1 AS value FROM goals WHERE group_id=?',
      teamId,
    ).value;
    const position = this.store.get(
      "SELECT COALESCE(MAX(queue_position),0)+1 AS value FROM goals WHERE group_id=? AND state='queued'",
      teamId,
    ).value;
    const goalId = randomUUID();
    const created = now();
    this.store.run(
      `INSERT INTO goals(
        id,group_id,number,state,queue_position,revision,cutoff_seq,outcome,final,
        finish_reason,origin_draft_id,created,started,ended
      ) VALUES(?,?,?,'queued',?,1,NULL,NULL,NULL,NULL,?,?,NULL,NULL)`,
      goalId,
      teamId,
      number,
      position,
      draft.id,
      created,
    );
    this.store.run(
      `INSERT INTO goal_contract_versions(goal_id,version,body,hash,approval,created)
       VALUES(?,?,?,?,?,?)`,
      goalId,
      1,
      draft.body,
      draft.hash,
      json({
        kind: 'user',
        draftId: draft.id,
        draftRevision: draft.revision,
        hash: draft.hash,
      }),
      created,
    );
    this.store.run(
      "UPDATE goal_drafts SET state='confirmed',goal_id=?,updated=? WHERE id=?",
      goalId,
      created,
      draft.id,
    );
    this.event(teamId, goalId, draft.id, 'goal.queued', { number, position });
    this.activateNextEligible(teamId);
    return {
      draft: this.draftView(this.store.get('SELECT * FROM goal_drafts WHERE id=?', draft.id)),
      goal: this.goalView(this.store.get('SELECT * FROM goals WHERE id=?', goalId)),
    };
  }

  activateNextEligible(teamId) {
    if (this.store.get(
      "SELECT 1 FROM goals WHERE group_id=? AND state IN ('active','finalizing')",
      teamId,
    )) return null;
    const queued = this.store.all(
      "SELECT * FROM goals WHERE group_id=? AND state='queued' ORDER BY queue_position,number",
      teamId,
    );
    for (const goal of queued) {
      const eligibility = this.startEligibility(teamId, goal);
      if (!eligibility.eligible) continue;
      const started = now();
      this.store.run(
        "UPDATE goals SET state='active',queue_position=NULL,revision=revision+1,started=? WHERE id=? AND state='queued'",
        started,
        goal.id,
      );
      this.event(teamId, goal.id, null, 'goal.activated', { trigger: 'queue' });
      return this.store.get('SELECT * FROM goals WHERE id=?', goal.id);
    }
    return null;
  }

  currentGoalView(teamId) {
    const row = this.store.get(
      "SELECT * FROM goals WHERE group_id=? AND state IN ('active','finalizing')",
      teamId,
    );
    return row ? this.goalView(row) : null;
  }

  queueViews(teamId) {
    const waitingForCurrent = Boolean(this.store.get(
      "SELECT 1 FROM goals WHERE group_id=? AND state IN ('active','finalizing')",
      teamId,
    ));
    return this.store.all(
      "SELECT * FROM goals WHERE group_id=? AND state='queued' ORDER BY queue_position,number",
      teamId,
    ).map(row => ({
      ...this.goalView(row),
      waitingForCurrent,
      eligibility: this.startEligibility(teamId, row),
    }));
  }

  startEligibility(teamId, goal) {
    const blockers = [];
    const team = this.store.group(teamId);
    if ((team.state ?? 'open') !== 'open') {
      blockers.push({ code: 'team_archived', detail: 'Team已归档' });
    }
    const mainAgentId = this.mainAgentId(teamId);
    if (!mainAgentId) {
      blockers.push({ code: 'main_controller_unavailable', detail: 'Main Agent不可用' });
    }
    let workspaceAccessible = false;
    try {
      workspaceAccessible = statSync(team.workspace).isDirectory();
    } catch {
      workspaceAccessible = false;
    }
    if (!workspaceAccessible) {
      blockers.push({ code: 'workspace_unavailable', detail: 'Team工作区不可访问' });
    }
    const contract = this.store.get(
      'SELECT body FROM goal_contract_versions WHERE goal_id=? ORDER BY version DESC LIMIT 1',
      goal.id,
    );
    if (!contract) {
      blockers.push({ code: 'contract_missing', detail: 'Goal Contract缺失' });
    } else {
      const body = parse(contract.body);
      const missing = (body.requirements?.requiredMemberIds ?? []).filter(memberId => !this.store.get(
        'SELECT 1 FROM members WHERE id=? AND group_id=? AND removed IS NULL',
        memberId,
        teamId,
      ));
      if (missing.length) {
        blockers.push({
          code: 'member_missing',
          detail: `必需成员不存在: ${missing.join(', ')}`,
        });
      }
    }
    return { eligible: blockers.length === 0, blockers };
  }

  requireMain(teamId, actor) {
    if (actor?.kind !== 'main_agent') throw new Error('仅当前Main Agent可以创建或修改Goal Draft');
    if (this.mainAgentId(teamId) !== actor.id) {
      throw new Error('当前Main Agent不匹配');
    }
  }

  mainAgentId(teamId) {
    const controller = this.store.get(
      'SELECT controller_id,state FROM team_lead_controllers WHERE group_id=?',
      teamId,
    );
    if (controller) return controller.state === 'active' ? controller.controller_id : null;
    return this.store.group(teamId).lead ?? null;
  }

  requireUser(actor) {
    if (actor?.kind !== 'user') throw new Error('仅用户可以确认Goal Draft');
  }

  requireOpen(teamId) {
    if ((this.store.group(teamId).state ?? 'open') !== 'open') {
      throw new Error('Team已归档，当前操作被冻结');
    }
  }

  draftView(row) {
    return {
      id: row.id,
      revision: row.revision,
      body: parse(row.body),
      hash: row.hash,
      state: row.state,
      goalId: row.goal_id,
      created: row.created,
      updated: row.updated,
    };
  }

  goalView(row) {
    const contractRow = this.store.get(
      'SELECT body,hash FROM goal_contract_versions WHERE goal_id=? ORDER BY version DESC LIMIT 1',
      row.id,
    );
    return {
      id: row.id,
      number: row.number,
      state: row.state,
      queuePosition: row.queue_position,
      revision: row.revision,
      cutoffSeq: row.cutoff_seq,
      unconsumedInboxCount: row.state === 'finalizing'
        ? this.unconsumedInboxCount(row)
        : null,
      outcome: row.outcome,
      final: row.final,
      finishReason: row.finish_reason,
      originDraftId: row.origin_draft_id,
      contract: contractRow ? parse(contractRow.body) : null,
      contractHash: contractRow?.hash ?? null,
      created: row.created,
      started: row.started,
      ended: row.ended,
    };
  }

  unconsumedInboxCount(goal) {
    const mainAgentId = this.mainAgentId(goal.group_id);
    if (!mainAgentId || goal.cutoff_seq == null) return 0;
    return this.store.get(
      `SELECT COUNT(*) AS value
       FROM messages m
       JOIN message_context c ON c.message_id=m.id
       WHERE c.goal_id=?
         AND m.kind='send'
         AND m.recipient=?
         AND m.seq<=?
         AND NOT EXISTS(
           SELECT 1
           FROM turn_inputs i
           JOIN turns t ON t.id=i.turn_id
           JOIN runtime_attempts r ON r.turn_id=t.id
           WHERE i.message_id=m.id AND r.state='completed'
         )
         AND NOT EXISTS(
           SELECT 1
           FROM panel_turn_inputs i
           JOIN panel_turns t ON t.id=i.turn_id
           WHERE i.message_id=m.id AND t.state='completed'
         )`,
      goal.id,
      mainAgentId,
      goal.cutoff_seq,
    ).value;
  }

  event(teamId, goalId, draftId, type, body) {
    this.store.run(
      'INSERT INTO goal_events(group_id,goal_id,draft_id,type,body,created) VALUES(?,?,?,?,?,?)',
      teamId,
      goalId,
      draftId,
      type,
      json(body),
      now(),
    );
  }
}
