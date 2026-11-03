// messages.awaiting:待投递是存储事实,进入 attached 后必须清零。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';

const NOW = '2026-01-01T00:00:00.000Z';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'message-awaiting-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const store = new Store(directory);
  store.run("INSERT INTO groups(id,name,workspace,created) VALUES('g','G','/tmp',?)", NOW);
  store.run("INSERT INTO members(id,group_id,name,host,role) VALUES('m1','g','one','fake','lead'),('m2','g','two','fake','member')");
  return { store, directory };
}

test('send messages are awaiting until attached; notes and user-facing sends are not', t => {
  const { store } = fixture(t);
  const recipient = store.conversation('member', 'm1', 'coordination');

  const first = store.append('g', 'm2', 'm1', 'send', 'one');
  const second = store.append('g', 'm2', 'm1', 'send', 'two');
  const note = store.append('g', 'm2', 'm1', 'note', 'later');
  const toUser = store.append('g', 'm2', 'user', 'send', 'answer');
  assert.equal(first.awaiting, 1);
  assert.equal(second.awaiting, 1);
  assert.equal(note.awaiting, 0);
  assert.equal(toUser.awaiting, 0);

  assert.deepEqual(store.pending().map(message => message.id), [first.id, second.id]);
  const entry = store.prepare(first, recipient);
  assert.ok(entry);
  // 同一接收者的另一条 send 也应被合批并清零。
  assert.equal(store.get('SELECT awaiting FROM messages WHERE id=?', first.id).awaiting, 0);
  assert.equal(store.get('SELECT awaiting FROM messages WHERE id=?', second.id).awaiting, 0);
  assert.equal(store.pending().length, 0);
  // 已进入队列的消息不会再次 prepare。
  assert.equal(store.prepare(first, recipient), null);
  store.close();
});

test('user-to-member directives stay awaiting until delivered', t => {
  const { store } = fixture(t);
  const target = store.conversation('member', 'm1', 'coordination');
  const directive = store.append('g', 'user', 'm1', 'send', 'do it');
  assert.equal(directive.awaiting, 1);
  assert.equal(store.pending().length, 1);
  store.prepare(directive, target);
  assert.equal(store.get('SELECT awaiting FROM messages WHERE id=?', directive.id).awaiting, 0);
  assert.equal(store.pending().length, 0);
  store.close();
});
