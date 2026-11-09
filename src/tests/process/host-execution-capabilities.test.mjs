import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeHost } from '../../hosts/claude.mjs';
import { createCodexHost } from '../../hosts/codex.mjs';

test('hosts report only writable filesystem boundaries they can enforce', () => {
  const claude = createClaudeHost({ command: 'claude', directory: '.', socketPath: 'socket' });
  const claudeWrite = claude.executionCapabilities({
    mode: 'workspace-write',
    allowShell: false,
    workspace: process.cwd(),
  });
  if (process.platform === 'win32') {
    assert.equal(claudeWrite.effectivePolicy, 'read-only');
    assert.deepEqual(claudeWrite.capabilities, ['file.read']);
  } else {
    assert.equal(claudeWrite.effectivePolicy, 'workspace-write');
    assert.ok(claudeWrite.capabilities.includes('filesystem.boundary'));
  }

  const codex = createCodexHost({ command: 'codex' });
  assert.deepEqual(codex.executionCapabilities({
    mode: 'workspace-write',
    allowShell: true,
    workspace: process.cwd(),
  }).capabilities, ['file.read', 'file.write', 'filesystem.boundary', 'shell.exec']);
});
