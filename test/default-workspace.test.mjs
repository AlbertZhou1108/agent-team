import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPanelWorkspace, ensureDefaultPanelWorkspace } from '../src/default-workspace.mjs';

test('default panel workspace adapts to the platform and documents presence', () => {
  // 路径拼接跟随运行平台的分隔符:断言用 join 构造,不写死分隔符。
  // macOS/Windows:Documents 下的用户可见目录。
  assert.equal(
    defaultPanelWorkspace({ home: '/Users/demo', platform: 'darwin' }),
    join('/Users/demo', 'Documents', 'AgentTeam'),
  );
  assert.equal(
    defaultPanelWorkspace({ home: 'C:\\Users\\demo', platform: 'win32' }),
    join('C:\\Users\\demo', 'Documents', 'AgentTeam'),
  );

  // Linux:Documents 缺席(无桌面环境)时回退 XDG 数据目录。
  assert.equal(
    defaultPanelWorkspace({ home: '/home/demo', platform: 'linux' }),
    join('/home/demo', '.local', 'share', 'agent-team', 'workspace'),
  );

  // Linux 桌面环境存在 Documents:同样使用用户可见目录。
  const desktopHome = mkdtempSync(join(tmpdir(), 'agent-home-'));
  try {
    mkdirSync(join(desktopHome, 'Documents'));
    assert.equal(
      defaultPanelWorkspace({ home: desktopHome, platform: 'linux' }),
      join(desktopHome, 'Documents', 'AgentTeam'),
    );
  } finally {
    rmSync(desktopHome, { recursive: true, force: true });
  }
});

test('ensureDefaultPanelWorkspace creates the directory idempotently', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-home-'));
  try {
    const first = ensureDefaultPanelWorkspace({ home, platform: 'darwin' });
    assert.equal(first, join(home, 'Documents', 'AgentTeam'));
    assert.ok(existsSync(first));
    // 再次调用不抛错(幂等)。
    assert.equal(ensureDefaultPanelWorkspace({ home, platform: 'darwin' }), first);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
