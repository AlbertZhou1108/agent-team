// Isolated feasibility prototype; deliberately not imported by production code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Bus } from '../../src/bus.mjs';
import { confirmedGroup } from '../../test/helpers.mjs';
const bytes = x => Buffer.byteLength(JSON.stringify(x));
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'information-feasibility-'));
  const calls = [];
  const host = { async run(c) { calls.push(c); c.onSession(c.endpoint.session ?? c.endpoint.id); c.onAccepted(); return ''; } };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => { await bus.close(); rmSync(directory, { recursive: true, force: true }); });
  const make = name => confirmedGroup(bus, { name, workspace: directory, lead: { name: 'lead', host: 'fake' }, members: [] });
  const group = make('target');
  const endpoint = bus.store.endpoint(group.lead, 'coordination');
  return { bus, group, endpoint, make, calls };
}
// References retain database identity; no filesystem access required for communication policy.
function reference(message) {
  return { id: message.id, sha256: createHash('sha256').update(message.text).digest('hex'), bytes: Buffer.byteLength(message.text), preview: message.text.slice(0, 512) };
}
function readReference(bus, endpoint, ref, offset = 0, limit = 1024) {
  const member = bus.store.member(endpoint.member_id);
  const row = bus.store.get('SELECT * FROM messages WHERE id=? AND group_id=?', ref.id, member.group_id);
  if (!row) throw Error('scope');
  if (reference(row).sha256 !== ref.sha256) throw Error('stale');
  return { text: row.text.slice(offset, offset + limit), next: Math.min(row.text.length, offset + limit), done: offset + limit >= row.text.length };
}

test('real baseline: message bodies dominate; bounded previews reduce default bytes but all expansion can cost more', async t => {
  const { bus, group, endpoint } = await fixture(t);
  const text = ('日志：中文与emoji🧪\n').repeat(1500) + '中部关键错误 E_MIDDLE\n' + '尾部完成';
  for (let i = 0; i < 50; i++) bus.store.append(group.id, group.lead, group.lead, 'note', text);
  const baseline = await bus.tool(endpoint.id, endpoint.key, 'read', {});
  const compact = baseline.messages.map(reference);
  assert.equal(baseline.messages.length, 50);
  assert.ok(bytes(compact) < bytes(baseline) * .1);
  const ref = compact[0];
  let restored = '', offset = 0, expandedBytes = 0;
  for (;;) {
    const page = readReference(bus, endpoint, ref, offset);
    restored += page.text; expandedBytes += bytes(page); offset = page.next;
    if (page.done) break;
  }
  assert.equal(restored, text);
  assert.ok(restored.includes('E_MIDDLE'));
  assert.ok(!ref.preview.includes('E_MIDDLE')); // Preview cannot support a correctness decision.
  assert.ok(expandedBytes + bytes(ref) > bytes(text));
  t.diagnostic(JSON.stringify({ baselineBytes: bytes(baseline), previewBytes: bytes(compact), reduction: 1 - bytes(compact) / bytes(baseline), fullExpansionBytes: expandedBytes + bytes(ref), originalTextBytes: bytes(text) }));
});

test('database references preserve team isolation, revoked access and stale-content detection', async t => {
  const { bus, group, endpoint, make } = await fixture(t);
  const other = make('other');
  const message = bus.store.append(group.id, group.lead, group.lead, 'note', '证据');
  const ref = reference(message);
  assert.deepEqual(ref, reference(message));
  assert.throws(() => readReference(bus, bus.store.endpoint(other.lead, 'coordination'), ref), /scope/);
  bus.store.run('UPDATE messages SET text=? WHERE id=?', 'changed', message.id);
  assert.throws(() => readReference(bus, endpoint, ref), /stale/);
  bus.store.run('UPDATE members SET removed=? WHERE id=?', 'now', group.lead);
  assert.throws(() => readReference(bus, endpoint, ref), /成员不存在或已移除/);
});

test('real baseline: event cursor does not bound snapshots or rules; projection leaves authority unchanged', async t => {
  const { bus, group, endpoint } = await fixture(t);
  const actor = { role: 'lead', context: 'coordination', group_id: group.id };
  for (let i = 0; i < 80; i++) bus.collaboration.apply(actor, { title: `item-${i}`, purpose: 'purpose'.repeat(100), standard: 'standard'.repeat(100), participants: [{ memberId: group.lead, role: 'executor' }], note: 'created' }, bus.collaboration.state(group.id).revision, `create-${i}`);
  const full = bus.collaboration.read(group.id);
  const after = bus.collaboration.read(group.id, full.nextAfter);
  assert.equal(after.records.length, 0);
  assert.equal(after.items.length, 80);
  const original = JSON.stringify(full);
  const view = { contract: full.contract, state: full.state, communicationOpen: full.communicationOpen, unknown: full.unknown, runningCount: full.runningCount, items: full.items.slice(0, 10).map(({ id, revision, state, title }) => ({ id, revision, state, title })), hasMore: true };
  assert.ok(bytes(view) < bytes(full) * .15);
  assert.equal(JSON.stringify(bus.collaboration.read(group.id)), original);
  assert.ok(bus.rules(endpoint).includes('item-79'));
  t.diagnostic(JSON.stringify({ snapshotBytes: bytes(full), afterCursorBytes: bytes(after), proposedPageBytes: bytes(view), currentRulesBytes: Buffer.byteLength(bus.rules(endpoint)) }));
});

test('real baseline: message cursor remains lossless across interleaved teams and insertions', async t => {
  const { bus, group, endpoint, make } = await fixture(t);
  const other = make('other');
  const expected = [];
  for (let i = 0; i < 12; i++) {
    expected.push(bus.store.append(group.id, group.lead, group.lead, 'note', `m${i}`).id);
    bus.store.append(other.id, other.lead, other.lead, 'note', 'foreign');
  }
  let after = 0; const seen = [];
  for (;;) {
    const page = await bus.tool(endpoint.id, endpoint.key, 'read', { after, limit: 3 });
    seen.push(...page.messages.map(m => m.id)); after = page.nextAfter;
    if (seen.length === 3) expected.push(bus.store.append(group.id, group.lead, group.lead, 'note', 'late').id);
    if (!page.messages.length) break;
  }
  assert.deepEqual(seen, expected);
});

test('real host seam: prompt and instructions are separate while tool schemas stay unchanged', async t => {
  const { bus, endpoint, calls } = await fixture(t);
  await bus.runEndpoint(endpoint, '本轮任务');
  const call = calls.at(-1);
  assert.equal(call.prompt, '本轮任务');
  assert.ok(call.instructions.includes('当前有效契约'));
  assert.equal(call.policy.mode, 'communication');
  assert.ok(call.tools.some(tool => tool.name === 'read'));
  // This proves an assembly seam, not that a native host accepts hot schema changes.
});

test('real entry rejects wrong endpoint key; long read can exceed existing RPC response cap', async t => {
 const {bus, group, endpoint} = await fixture(t);
 await assert.rejects(bus.tool(endpoint.id, 'wrong-key', 'read', {}));
 for(let i=0;i<50;i++) bus.store.append(group.id,group.lead,group.lead,'note','x'.repeat(90000));
 const result=await bus.tool(endpoint.id,endpoint.key,'read',{});
 assert.ok(JSON.stringify(result).length>4*1024*1024);
 t.diagnostic('50 messages can exceed rpc() 4 MiB guard: bounded record count is not a bounded payload.');
});
