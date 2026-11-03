import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';

// 回归保护:每个 token 级事件都是一次 autocommit,若 synchronous 回到 FULL,
// 每次提交都要 fsync(实测 D 盘 27ms/次),团队多成员并发时写入速率会超过磁盘上限,
// 事件循环被独占导致面板接口长时间不可达。WAL + NORMAL 仍保证一致性,只放弃逐条落盘。
test('store keeps WAL durability at NORMAL so per-event commits do not fsync', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-store-sync-'));
  const store = new Store(directory);
  try {
    assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal');
    // SQLite 的 synchronous 取值:0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
    assert.equal(store.get('PRAGMA synchronous').synchronous, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
