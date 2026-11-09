import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../../store.mjs';

test('v10 databases gain plan tables and agent_tasks.revision', t => {
  const directory = mkdtempSync(join(tmpdir(), 'task-schema-v11-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const legacy = new Store(directory);
  legacy.db.exec(`DROP TABLE plan_events;
    DROP TABLE message_step_refs;
    ALTER TABLE agent_tasks DROP COLUMN revision;
    PRAGMA user_version=10;`);
  legacy.db.close();

  const upgraded = new Store(directory);
  assert.equal(upgraded.schemaVersion(), SCHEMA_VERSION);
  assert.ok(upgraded.all("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plan_events'").length);
  assert.ok(upgraded.all("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_step_refs'").length);
  assert.ok(upgraded.all('PRAGMA table_info(agent_tasks)').some(column => column.name === 'revision'));
  upgraded.db.close();
});
