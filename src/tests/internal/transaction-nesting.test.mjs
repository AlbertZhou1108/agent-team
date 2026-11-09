// 事务嵌套:store.transaction() 在事务中使用 SAVEPOINT,不再报
// "cannot start a transaction within a transaction";EventLog 在事务内冲刷应加入外层事务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import { EventLog } from '../../event-log.mjs';

const NOW = '2026-01-01T00:00:00.000Z';

function tempStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'store-transaction-'));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return store;
}

function insertGroup(store, id) {
  store.run(
    'INSERT INTO groups(id,name,workspace,lead,created,charter,policy,allow_shell) VALUES(?,?,?,?,?,?,?,?)',
    id, id, '/tmp', null, NOW, null, 'workspace-write', 0,
  );
}

function insertMember(store, id, groupId) {
  store.run(
    'INSERT INTO members(id,group_id,name,host,role,profile) VALUES(?,?,?,?,?,?)',
    id, groupId, id, 'codex', 'executor', '',
  );
}

test('nested transactions commit together with the outer transaction', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  store.transaction(() => {
    insertMember(store, 'm1', 'g1');
    store.transaction(() => {
      insertMember(store, 'm2', 'g1');
    });
  });
  assert.equal(store.get("SELECT count(*) AS c FROM members WHERE group_id='g1'").c, 2);
});

test('an inner failure rolls back only the inner savepoint', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  store.transaction(() => {
    insertMember(store, 'outer', 'g1');
    assert.throws(() => {
      store.transaction(() => {
        insertMember(store, 'inner', 'g1');
        throw new Error('boom');
      });
    }, /boom/);
    insertMember(store, 'after', 'g1');
  });
  assert.ok(store.get("SELECT 1 FROM members WHERE id='outer'"));
  assert.equal(store.get("SELECT 1 FROM members WHERE id='inner'"), undefined);
  assert.ok(store.get("SELECT 1 FROM members WHERE id='after'"));
});

test('an outer rollback discards inner committed savepoints', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  assert.throws(() => {
    store.transaction(() => {
      store.transaction(() => insertMember(store, 'kept-until-outer-fails', 'g1'));
      throw new Error('outer');
    });
  }, /outer/);
  assert.equal(store.get("SELECT count(*) AS c FROM members WHERE id='kept-until-outer-fails'").c, 0);
});

test('three levels of nesting roll back the failed level only', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  store.transaction(() => {
    insertMember(store, 'a', 'g1');
    store.transaction(() => {
      insertMember(store, 'b', 'g1');
      assert.throws(() => {
        store.transaction(() => {
          insertMember(store, 'c', 'g1');
          throw new Error('level-3');
        });
      }, /level-3/);
      insertMember(store, 'd', 'g1');
    });
    insertMember(store, 'e', 'g1');
  });
  const ids = store.all('SELECT id FROM members ORDER BY id').map(row => row.id);
  assert.deepEqual(ids, ['a', 'b', 'd', 'e']);
});

test('transaction depth is restored after a failure and the next top-level transaction runs', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  assert.throws(() => store.transaction(() => {
    store.transaction(() => {
      throw new Error('nested');
    });
  }), /nested/);
  store.transaction(() => insertMember(store, 'ok', 'g1'));
  assert.ok(store.get("SELECT 1 FROM members WHERE id='ok'"));
});

test('EventLog flush inside a transaction joins the outer transaction', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  insertMember(store, 'm1', 'g1');
  const conversation = store.conversation('member', 'm1', 'coordination');
  const log = new EventLog(store, { flushMs: 60000 });
  t.after(() => log.close());

  // 事务内冲刷不再抛嵌套事务错误,且随外层回滚一起丢弃。
  assert.throws(() => {
    store.transaction(() => {
      log.member(conversation.id, { type: 'framework.text.delta', text: 'rolled back' });
      log.flush();
      throw new Error('outer rollback');
    });
  }, /outer rollback/);
  assert.equal(store.all('SELECT * FROM history').length, 0);

  // 同样的冲刷在提交事务后应落库。
  store.transaction(() => {
    log.member(conversation.id, { type: 'framework.text.delta', text: 'committed' });
    log.flush();
  });
  const rows = store.all('SELECT event FROM history');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].event).text, 'committed');
});
