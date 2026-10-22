import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { TeamGoalLifecycle } from '../src/team-goal-lifecycle.mjs';
import { Collaboration } from '../src/collaboration.mjs';
import { testContract } from './helpers.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-goal-lifecycle-'));
  const store = new Store(directory);
  store.run('INSERT INTO groups VALUES(?,?,?,?,?)', 'team', 'Lifecycle Team', directory, 'lead', '2026-10-23T00:00:00.000Z');
  store.run('INSERT INTO members(id,group_id,name,host,role) VALUES(?,?,?,?,?)', 'lead', 'team', 'Lead', 'fake', 'lead');
  store.run(
    'INSERT INTO team_lead_controllers VALUES(?,?,?,?,?,?,?)',
    'team',
    'member',
    'lead',
    'active',
    null,
    1,
    '2026-10-23T00:00:00.000Z',
  );
  new Collaboration(store);
  const lifecycle = new TeamGoalLifecycle(store);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { lifecycle, store };
}

test('main Agent can create multiple editable Goal Drafts', t => {
  const { lifecycle } = fixture(t);
  const initial = lifecycle.read('team');
  assert.equal(initial.team.state, 'open');
  assert.equal(initial.team.revision, 1);
  assert.deepEqual(initial.drafts, []);

  const first = lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.create',
      contract: testContract,
      requirements: { requiredMemberIds: ['lead'] },
    },
    1,
    'draft-create-1',
  );
  const second = lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.create',
      contract: { ...testContract, goal: '第二个目标' },
      requirements: { requiredMemberIds: [] },
    },
    first.revision,
    'draft-create-2',
  );

  const state = lifecycle.read('team');
  assert.equal(state.team.revision, second.revision);
  assert.equal(state.drafts.length, 2);
  assert.deepEqual(state.drafts.map(draft => draft.revision), [1, 1]);
  assert.deepEqual(state.drafts.map(draft => draft.body.contract.goal), [
    testContract.goal,
    '第二个目标',
  ]);
  assert.ok(state.drafts.every(draft => draft.hash.length === 64));
});

test('Goal Draft requires the user to confirm its exact revision before scheduling', t => {
  const { lifecycle } = fixture(t);
  const created = lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.create',
      contract: testContract,
      requirements: { requiredMemberIds: ['lead'] },
    },
    1,
    'draft-create',
  );
  const draft = created.draft;

  assert.throws(() => lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.confirm',
      draftId: draft.id,
      draftRevision: draft.revision,
      hash: draft.hash,
    },
    created.revision,
    'agent-confirm',
  ), /用户/);

  const confirmed = lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'draft.confirm',
      draftId: draft.id,
      draftRevision: draft.revision,
      hash: draft.hash,
    },
    created.revision,
    'user-confirm',
  );

  assert.equal(confirmed.goal.state, 'active');
  assert.equal(confirmed.goal.number, 1);
  assert.equal(confirmed.goal.originDraftId, draft.id);
  assert.deepEqual(confirmed.goal.contract, draft.body);
  const state = lifecycle.read('team');
  assert.deepEqual(state.drafts, []);
  assert.deepEqual(state.queue, []);
  assert.equal(state.current.id, confirmed.goal.id);
  assert.equal(state.current.state, 'active');
});

test('editing a Goal Draft creates a new revision and invalidates the previous confirmation target', t => {
  const { lifecycle } = fixture(t);
  const created = lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.create',
      contract: testContract,
      requirements: { requiredMemberIds: [] },
    },
    1,
    'draft-create',
  );
  const updated = lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.update',
      draftId: created.draft.id,
      draftRevision: created.draft.revision,
      contract: { ...testContract, goal: '修订后的目标' },
      requirements: { requiredMemberIds: ['lead'] },
    },
    created.revision,
    'draft-update',
  );

  assert.equal(updated.draft.revision, 2);
  assert.equal(updated.draft.body.contract.goal, '修订后的目标');
  assert.deepEqual(updated.draft.body.requirements.requiredMemberIds, ['lead']);
  assert.notEqual(updated.draft.hash, created.draft.hash);
  assert.throws(() => lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'draft.confirm',
      draftId: created.draft.id,
      draftRevision: created.draft.revision,
      hash: created.draft.hash,
    },
    updated.revision,
    'stale-confirm',
  ), /版本冲突/);
});

test('only the user can delete an unconfirmed Goal Draft', t => {
  const { lifecycle } = fixture(t);
  const created = lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.create',
      contract: testContract,
      requirements: { requiredMemberIds: [] },
    },
    1,
    'draft-create',
  );
  assert.throws(() => lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.delete',
      draftId: created.draft.id,
      draftRevision: created.draft.revision,
    },
    created.revision,
    'agent-delete',
  ), /用户/);

  const deleted = lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'draft.delete',
      draftId: created.draft.id,
      draftRevision: created.draft.revision,
    },
    created.revision,
    'user-delete',
  );
  assert.equal(deleted.draft.state, 'deleted');
  assert.deepEqual(lifecycle.read('team').drafts, []);
  assert.throws(() => lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'draft.confirm',
      draftId: created.draft.id,
      draftRevision: created.draft.revision,
      hash: created.draft.hash,
    },
    deleted.revision,
    'confirm-deleted',
  ), /已经确认或删除/);
});

test('users can reorder and cancel queued Goals while terminating the Current Goal advances the queue', t => {
  const { lifecycle } = fixture(t);
  const create = (title, operationId, revision) => lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.create',
      contract: { ...testContract, goal: title },
      requirements: { requiredMemberIds: [] },
    },
    revision,
    `create-${operationId}`,
  );
  const confirm = (draft, operationId, revision) => lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'draft.confirm',
      draftId: draft.id,
      draftRevision: draft.revision,
      hash: draft.hash,
    },
    revision,
    `confirm-${operationId}`,
  );

  const aDraft = create('A', 'a', 1);
  const a = confirm(aDraft.draft, 'a', aDraft.revision);
  const bDraft = create('B', 'b', a.revision);
  const b = confirm(bDraft.draft, 'b', bDraft.revision);
  const cDraft = create('C', 'c', b.revision);
  const c = confirm(cDraft.draft, 'c', cDraft.revision);
  assert.equal(a.goal.state, 'active');
  assert.equal(b.goal.state, 'queued');
  assert.equal(c.goal.state, 'queued');

  const reordered = lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'queue.reorder',
      orderedGoalIds: [c.goal.id, b.goal.id],
    },
    c.revision,
    'reorder',
  );
  assert.deepEqual(reordered.queue.map(goal => goal.id), [c.goal.id, b.goal.id]);

  const terminated = lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'goal.terminate',
      goalId: a.goal.id,
      reason: '用户改用下一项任务',
    },
    reordered.revision,
    'terminate-a',
  );
  assert.equal(terminated.goal.state, 'terminated');
  assert.equal(terminated.current.id, c.goal.id);
  assert.equal(terminated.current.state, 'active');
  assert.deepEqual(terminated.queue.map(goal => goal.id), [b.goal.id]);

  const cancelled = lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'queue.cancel',
      goalId: b.goal.id,
      reason: '不再需要',
    },
    terminated.revision,
    'cancel-b',
  );
  assert.equal(cancelled.goal.state, 'cancelled');
  assert.deepEqual(cancelled.queue, []);
  assert.equal(lifecycle.read('team').current.id, c.goal.id);
});

test('scheduler skips an ineligible queued Goal without moving or cancelling it', t => {
  const { lifecycle, store } = fixture(t);
  store.run(
    'INSERT INTO members(id,group_id,name,host,role) VALUES(?,?,?,?,?)',
    'worker',
    'team',
    'Worker',
    'fake',
    'member',
  );
  const create = (title, requiredMemberIds) => lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.create',
      contract: { ...testContract, goal: title },
      requirements: { requiredMemberIds },
    },
    lifecycle.read('team').team.revision,
    `create-${title}`,
  );
  const confirm = draft => lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'draft.confirm',
      draftId: draft.id,
      draftRevision: draft.revision,
      hash: draft.hash,
    },
    lifecycle.read('team').team.revision,
    `confirm-${draft.id}`,
  );

  const blockedDraft = create('blocked', ['worker']);
  store.run('UPDATE members SET removed=? WHERE id=?', '2026-10-23T01:00:00.000Z', 'worker');
  const blocked = confirm(blockedDraft.draft);
  assert.equal(blocked.goal.state, 'queued');
  const runnableDraft = create('runnable', ['lead']);
  const runnable = confirm(runnableDraft.draft);

  assert.equal(runnable.goal.state, 'active');
  const afterActivation = lifecycle.read('team');
  assert.equal(afterActivation.current.id, runnable.goal.id);
  assert.deepEqual(afterActivation.queue.map(goal => goal.id), [blocked.goal.id]);
  assert.equal(afterActivation.queue[0].eligibility.eligible, false);
  assert.deepEqual(
    afterActivation.queue[0].eligibility.blockers.map(blocker => blocker.code),
    ['member_missing'],
  );

  const terminated = lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'goal.terminate',
      goalId: runnable.goal.id,
      reason: '测试队列全部阻塞',
    },
    afterActivation.team.revision,
    'terminate-runnable',
  );
  assert.equal(terminated.current, null);
  assert.deepEqual(terminated.queue.map(goal => goal.id), [blocked.goal.id]);
});

test('archiving freezes Drafts and Queue, requires no Current Goal, and restores them', t => {
  const { lifecycle, store } = fixture(t);
  store.run(
    'INSERT INTO members(id,group_id,name,host,role) VALUES(?,?,?,?,?)',
    'worker',
    'team',
    'Worker',
    'fake',
    'member',
  );
  const create = (title, requiredMemberIds = []) => lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.create',
      contract: { ...testContract, goal: title },
      requirements: { requiredMemberIds },
    },
    lifecycle.read('team').team.revision,
    `create-${title}`,
  );
  const confirm = draft => lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'draft.confirm',
      draftId: draft.id,
      draftRevision: draft.revision,
      hash: draft.hash,
    },
    lifecycle.read('team').team.revision,
    `confirm-${draft.id}`,
  );

  const active = confirm(create('active').draft);
  assert.throws(() => lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    { type: 'team.archive' },
    active.revision,
    'archive-active',
  ), /Current Goal/);
  const terminated = lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'goal.terminate',
      goalId: active.goal.id,
      reason: '准备归档',
    },
    active.revision,
    'terminate-active',
  );

  const blockedDraft = create('blocked', ['worker']);
  store.run('UPDATE members SET removed=? WHERE id=?', '2026-10-23T02:00:00.000Z', 'worker');
  const blocked = confirm(blockedDraft.draft);
  assert.equal(blocked.goal.state, 'queued');
  const editable = create('editable');
  assert.equal(editable.draft.state, 'draft');

  const archived = lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    { type: 'team.archive' },
    lifecycle.read('team').team.revision,
    'archive-team',
  );
  assert.equal(archived.team.state, 'archived');
  assert.deepEqual(archived.queue.map(goal => goal.id), [blocked.goal.id]);
  assert.deepEqual(archived.drafts.map(draft => draft.id), [editable.draft.id]);
  assert.equal(archived.queue[0].eligibility.eligible, false);
  assert.ok(archived.queue[0].eligibility.blockers.some(blocker => blocker.code === 'team_archived'));

  assert.throws(() => lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.update',
      draftId: editable.draft.id,
      draftRevision: editable.draft.revision,
      contract: { ...testContract, goal: '归档期间修改' },
      requirements: { requiredMemberIds: [] },
    },
    archived.revision,
    'update-archived',
  ), /归档/);

  const restored = lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    { type: 'team.restore' },
    archived.revision,
    'restore-team',
  );
  assert.equal(restored.team.state, 'open');
  assert.deepEqual(restored.queue.map(goal => goal.id), [blocked.goal.id]);
  assert.deepEqual(restored.drafts.map(draft => draft.id), [editable.draft.id]);
  assert.equal(restored.current, null);
  assert.equal(terminated.current, null);
});

test('legacy Team state migrates into an open Team and an explicit Goal exactly once', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-goal-migration-'));
  let store = new Store(directory);
  store.run('INSERT INTO groups VALUES(?,?,?,?,?)', 'legacy', 'Legacy', directory, 'lead', '2026-10-01T00:00:00.000Z');
  store.run('INSERT INTO members(id,group_id,name,host,role) VALUES(?,?,?,?,?)', 'lead', 'legacy', 'Lead', 'fake', 'lead');
  store.run(
    'INSERT INTO team_lead_controllers VALUES(?,?,?,?,?,?,?)',
    'legacy',
    'member',
    'lead',
    'active',
    null,
    1,
    '2026-10-01T00:00:00.000Z',
  );
  new Collaboration(store);
  store.run(
    'INSERT INTO contract_versions VALUES(?,?,?,?,?,?)',
    'legacy',
    1,
    JSON.stringify(testContract),
    'legacy-contract-hash',
    JSON.stringify({ source: 'legacy' }),
    '2026-10-01T00:00:00.000Z',
  );
  store.run(
    'INSERT INTO team_state(group_id,revision,goal_version,contract_version,phase,outcome,final,finish_reason) VALUES(?,?,?,?,?,?,?,?)',
    'legacy',
    4,
    1,
    1,
    'active',
    null,
    null,
    null,
  );
  store.run(
    'INSERT INTO work_items(id,group_id,goal_version,revision,state,body) VALUES(?,?,?,?,?,?)',
    'legacy-item',
    'legacy',
    1,
    1,
    'pending',
    JSON.stringify({ title: 'legacy work' }),
  );
  const legacyMessage = store.append('legacy', 'lead', 'lead', 'send', 'legacy report');
  store.run(
    'INSERT INTO message_context(message_id,work_item_id,contract_version) VALUES(?,?,?)',
    legacyMessage.id,
    'legacy-item',
    1,
  );
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  let lifecycle = new TeamGoalLifecycle(store);
  let state = lifecycle.read('legacy');
  assert.equal(state.team.state, 'open');
  assert.equal(state.current.number, 1);
  assert.equal(state.current.state, 'active');
  assert.equal(state.current.contract.contract.goal, testContract.goal);
  assert.equal(store.get('SELECT goal_id FROM work_items WHERE id=?', 'legacy-item').goal_id, state.current.id);
  assert.equal(store.get('SELECT goal_id FROM message_context WHERE message_id=?', legacyMessage.id).goal_id, state.current.id);

  store.close();
  store = new Store(directory);
  lifecycle = new TeamGoalLifecycle(store);
  state = lifecycle.read('legacy');
  assert.equal(state.current.number, 1);
  assert.equal(store.all('SELECT * FROM goals WHERE group_id=?', 'legacy').length, 1);
});

test('finalizing snapshots a cutoff and only unconsumed Goal Inbox messages before it block completion', t => {
  const { lifecycle, store } = fixture(t);
  store.run(
    'INSERT INTO members(id,group_id,name,host,role) VALUES(?,?,?,?,?)',
    'worker',
    'team',
    'Worker',
    'fake',
    'member',
  );
  const created = lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    {
      type: 'draft.create',
      contract: testContract,
      requirements: { requiredMemberIds: ['worker'] },
    },
    1,
    'draft-create',
  );
  const confirmed = lifecycle.apply(
    'team',
    { kind: 'user', id: 'local-user' },
    {
      type: 'draft.confirm',
      draftId: created.draft.id,
      draftRevision: created.draft.revision,
      hash: created.draft.hash,
    },
    created.revision,
    'draft-confirm',
  );
  const report = store.append('team', 'worker', 'lead', 'send', 'progress');
  store.run(
    'INSERT INTO message_context(message_id,work_item_id,contract_version,goal_id) VALUES(?,?,?,?)',
    report.id,
    null,
    1,
    confirmed.goal.id,
  );

  const finalizing = lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    { type: 'goal.finish-request', goalId: confirmed.goal.id },
    confirmed.revision,
    'finish-request',
  );
  assert.equal(finalizing.current.state, 'finalizing');
  assert.equal(finalizing.current.cutoffSeq, report.seq);
  assert.equal(finalizing.current.unconsumedInboxCount, 1);

  const endpoint = store.endpoint('lead', 'coordination');
  const turn = store.createTurn(endpoint, [report]);
  store.run(
    `INSERT INTO runtime_attempts(
      turn_id,group_id,endpoint_id,state,policy,contract_version,detail,created,ended,goal_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    turn,
    'team',
    endpoint.id,
    'completed',
    '{}',
    1,
    null,
    '2026-10-23T03:00:00.000Z',
    '2026-10-23T03:00:01.000Z',
    confirmed.goal.id,
  );
  assert.equal(lifecycle.read('team').current.unconsumedInboxCount, 0);

  const late = store.append('team', 'worker', 'lead', 'send', 'late progress');
  store.run(
    'INSERT INTO message_context(message_id,work_item_id,contract_version,goal_id) VALUES(?,?,?,?)',
    late.id,
    null,
    1,
    confirmed.goal.id,
  );
  assert.ok(late.seq > finalizing.current.cutoffSeq);
  assert.equal(lifecycle.read('team').current.unconsumedInboxCount, 0);

  const withdrawn = lifecycle.apply(
    'team',
    { kind: 'main_agent', id: 'lead' },
    { type: 'goal.finish-withdraw', goalId: confirmed.goal.id, reason: '处理迟到消息' },
    finalizing.revision,
    'finish-withdraw',
  );
  assert.equal(withdrawn.current.state, 'active');
  assert.equal(withdrawn.current.cutoffSeq, null);
  assert.equal(withdrawn.current.unconsumedInboxCount, null);
});
