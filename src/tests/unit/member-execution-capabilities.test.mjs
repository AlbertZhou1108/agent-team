// 成员执行能力裁剪：四宿主差异由 traits 表达，公共分支只有一份实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { memberExecutionCapabilities } from '../../hosts/execution.mjs';
import { CODEX_TRAITS } from '../../member/codex/index.mjs';
import { CLAUDE_TRAITS } from '../../member/claude/index.mjs';
import { DSH_TRAITS } from '../../member/dsh/index.mjs';
import { ZCODE_TRAITS } from '../../member/zcode/index.mjs';

const FULL = ['exec.read', 'exec.write'];

test('communication never yields execution capabilities', () => {
  for (const traits of [{}, CODEX_TRAITS, CLAUDE_TRAITS]) {
    const result = memberExecutionCapabilities(traits, { mode: 'communication', allowShell: true });
    assert.equal(result.effectivePolicy, 'communication');
    assert.deepEqual(result.capabilities, []);
  }
});

test('read-only exposes read, and only codex keeps a read-only shell', () => {
  const codex = memberExecutionCapabilities(CODEX_TRAITS, { mode: 'read-only', allowShell: true });
  assert.equal(codex.effectivePolicy, 'read-only');
  assert.deepEqual(codex.capabilities, ['exec.read', 'exec.shell']);
  assert.match(codex.reason, /只读沙箱/);

  for (const traits of [DSH_TRAITS, ZCODE_TRAITS, CLAUDE_TRAITS]) {
    const result = memberExecutionCapabilities(traits, { mode: 'read-only', allowShell: true });
    assert.deepEqual(result.capabilities, ['exec.read']);
    assert.equal(result.reason, '群策略只允许读取');
  }
});

test('codex degrades the whole class to communication without shell', () => {
  const result = memberExecutionCapabilities(CODEX_TRAITS, { mode: 'workspace-write', allowShell: false });
  assert.equal(result.effectivePolicy, 'communication');
  assert.deepEqual(result.capabilities, []);
  assert.match(result.reason, /未启用 shell/);
});

test('workspace-write keeps files, and shell follows allowShell', () => {
  for (const traits of [DSH_TRAITS, ZCODE_TRAITS]) {
    const withShell = memberExecutionCapabilities(traits, { mode: 'workspace-write', allowShell: true });
    assert.equal(withShell.effectivePolicy, 'workspace-write');
    assert.deepEqual(withShell.capabilities, [...FULL, 'exec.shell']);
    assert.equal(withShell.reason, null);

    const withoutShell = memberExecutionCapabilities(traits, { mode: 'workspace-write', allowShell: false });
    assert.deepEqual(withoutShell.capabilities, FULL);
  }
});

test('zcode explains a shell-less workspace-write differently', () => {
  const result = memberExecutionCapabilities(ZCODE_TRAITS, { mode: 'workspace-write', allowShell: false });
  assert.equal(result.reason, '未启用 shell；执行边界依赖 ZCode 会话权限模式');
});

test('claude on windows degrades to read-only', () => {
  const win = memberExecutionCapabilities(CLAUDE_TRAITS, { mode: 'workspace-write', allowShell: true, platform: 'win32' });
  assert.equal(win.effectivePolicy, 'read-only');
  assert.deepEqual(win.capabilities, ['exec.read']);
  assert.match(win.reason, /Windows/);

  const mac = memberExecutionCapabilities(CLAUDE_TRAITS, { mode: 'workspace-write', allowShell: true, platform: 'darwin' });
  assert.equal(mac.effectivePolicy, 'workspace-write');
  assert.deepEqual(mac.capabilities, [...FULL, 'exec.shell']);
});

test('read-only is checked before the platform boundary trait', () => {
  const result = memberExecutionCapabilities(CLAUDE_TRAITS, { mode: 'read-only', allowShell: false, platform: 'win32' });
  assert.equal(result.effectivePolicy, 'read-only');
  assert.equal(result.reason, '群策略只允许读取');
});
