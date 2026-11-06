// 随心记的表结构与升级路径:旧库补表、新库直建、约束生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../../src/store.mjs';

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'store-notes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

const NOW = '2026-01-01T00:00:00.000Z';

test('a v5 database gains the notes table and indexes on reopen', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run('DROP TABLE notes');
  store.setSchemaVersion(5);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'"));
  const indexes = store.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notes'").map(row => row.name);
  assert.ok(indexes.includes('notes_state'));
  assert.ok(indexes.includes('notes_archived'));
  store.close();
});

test('notes reject unknown states and tolerate an empty table', t => {
  const directory = tempDir(t);
  const store = new Store(directory);
  assert.deepEqual(store.all('SELECT * FROM notes'), []);
  store.run(
    "INSERT INTO notes(id,title,body,state,created,updated) VALUES('a','t','b','active',?,?)",
    NOW,
    NOW,
  );
  assert.throws(() => store.run(
    "INSERT INTO notes(id,title,body,state,created,updated) VALUES('b','t','b','doing',?,?)",
    NOW,
    NOW,
  ), /CHECK/);
  store.close();
});

test('a v7 database gains the optional source team without touching existing notes', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO notes(id,title,body,state,created,updated) VALUES('a','t','b','active',?,?)", NOW, NOW);
  store.run('DROP INDEX IF EXISTS notes_source_team');
  store.run('ALTER TABLE notes DROP COLUMN source_team_id');
  store.setSchemaVersion(7);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.ok(store.all('PRAGMA table_info(notes)').some(column => column.name === 'source_team_id'));
  assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE type='index' AND name='notes_source_team'"));
  assert.equal(store.get("SELECT source_team_id FROM notes WHERE id='a'").source_team_id, null, '历史笔记一律无来源');
  store.close();
});

test('notes keep no foreign key to groups so deleting a team cannot cascade into private notes', t => {
  const directory = tempDir(t);
  const store = new Store(directory);
  const column = store.all('PRAGMA table_info(notes)').find(item => item.name === 'source_team_id');
  assert.ok(column, 'source_team_id 必须存在');
  assert.equal(column.notnull, 0, '无来源是合法状态');
  assert.deepEqual(store.all('PRAGMA foreign_key_list(notes)'), [], '来源是裸 id，刻意不加外键');
  store.close();
});
