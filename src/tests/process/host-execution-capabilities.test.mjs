import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeHost } from '../../hosts/claude/index.mjs';
import { createCodexHost } from '../../hosts/codex/index.mjs';

test('hosts report only writable filesystem boundaries they can enforce', () => {
  const claude = createClaudeHost({ command: 'claude', directory: '.', socketPath: 'socket' });
  const claudeWrite = claude.executionCapabilities({
    mode: 'workspace-write',
    allowShell: false,
    workspace: process.cwd(),
  });
  if (process.platform === 'win32') {
    assert.equal(claudeWrite.effectivePolicy, 'read-only');
    assert.deepEqual(claudeWrite.capabilities, ['exec.read']);
  } else {
    assert.equal(claudeWrite.effectivePolicy, 'workspace-write');
    assert.ok(claudeWrite.capabilities.includes('exec.write'));
  }

  const codex = createCodexHost({ command: 'codex' });
  assert.deepEqual(codex.executionCapabilities({
    mode: 'workspace-write',
    allowShell: true,
    workspace: process.cwd(),
  }).capabilities, ['exec.read', 'exec.write', 'exec.shell']);
});
