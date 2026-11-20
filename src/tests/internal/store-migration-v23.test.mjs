// v23 桌面应用注册表枚举扩展:kind CHECK 加入 'zcode'(第四家桌面接入)。
// CHECK 是 schema 级约束,SQLite 不能改,按列信息重建;用「回退手术」把当前库
// 剥成 v22 形状再重开,验证既有行不丢、新枚举生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../../store.mjs';

const NOW = '2026-01-01T00:00:00.000Z';

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'store-schema-v23-'));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  return directory;
}

/** 把当前库回退成 v22 形状:desktop_applications 重建为不含 zcode 的 kind 枚举,行数据拷回。 */
function downgradeToV22(store) {
  store.transaction(() => {
    store.db.exec(`ALTER TABLE desktop_applications RENAME TO desktop_applications_v23_tmp;
      CREATE TABLE desktop_applications(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('codex','dsh','claude')),
        surface TEXT NOT NULL DEFAULT 'desktop' CHECK(surface IN ('cli','desktop')),
        install_path TEXT,
        engine_path TEXT,
        engine_version TEXT,
        readiness TEXT NOT NULL DEFAULT 'unavailable' CHECK(readiness IN ('available','unavailable')),
        pull_only INTEGER NOT NULL DEFAULT 0,
        controller_state TEXT,
        engine_state TEXT,
        diagnostics TEXT,
        fingerprint TEXT,
        verified_at TEXT,
        lifecycle_note TEXT,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        user_disabled INTEGER NOT NULL DEFAULT 0,
        disabled_reason TEXT,
        bundle_version TEXT,
        UNIQUE(kind,surface,install_path));
      INSERT INTO desktop_applications SELECT * FROM desktop_applications_v23_tmp;
      DROP TABLE desktop_applications_v23_tmp;`);
  });
  store.setSchemaVersion(22);
}

test('a v22 database widens the desktop kind enum without losing rows', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  // v22 时代的真实数据:一个已验收可用的 codex 行(验证状态随行保留)。
  store.run(
    `INSERT INTO desktop_applications(id,kind,surface,install_path,bundle_version,readiness,pull_only,verified_at,created,updated)
     VALUES('app1','codex','desktop','/Applications/ChatGPT.app','26.1111.71704','available',1,?, ?, ?)`,
    '2026-11-20T00:00:00.000Z', NOW, NOW,
  );
  downgradeToV22(store);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  // 数据不丢:验证结论、pull-only、bundle 版本随行保留。
  const row = store.get('SELECT * FROM desktop_applications WHERE id=?', 'app1');
  assert.equal(row.kind, 'codex');
  assert.equal(row.readiness, 'available');
  assert.equal(row.pull_only, 1);
  assert.equal(row.bundle_version, '26.1111.71704');
  // 新枚举接受 zcode 行;未知 kind 仍被 CHECK 拒绝。
  store.run(
    `INSERT INTO desktop_applications(id,kind,surface,install_path,created,updated)
     VALUES('app2','zcode','desktop','/Applications/ZCode.app',?,?)`,
    NOW, NOW,
  );
  assert.throws(
    () => store.run(
      `INSERT INTO desktop_applications(id,kind,surface,install_path,created,updated)
       VALUES('app3','workbuddy','desktop','/x',?,?)`,
      NOW, NOW,
    ),
    /CHECK/,
  );
  store.close();
});

test('a fresh database carries the widened kind enum directly', t => {
  const directory = tempDir(t);
  const store = new Store(directory);
  const tableSql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='desktop_applications'").sql;
  assert.match(tableSql, /'zcode'/);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  store.close();
});
