import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_CAPABILITIES,
  assertControlPolicy,
  assertControlWorkspace,
  assertControllerCapabilities,
  normalizeControlCapabilities,
} from '../../control-capabilities.mjs';

test('controller capabilities require delivery and observation', () => {
  assert.throws(
    () => assertControllerCapabilities({
      capabilities: [CONTROL_CAPABILITIES.messageDelivery],
    }),
    /turn\.observe/,
  );
  assert.deepEqual(
    assertControllerCapabilities({
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: ['/workspace'],
      policies: ['read-only'],
    }).workspaceRoots,
    ['/workspace'],
  );
});

test('legacy capability ids normalize to the unified vocabulary', () => {
  const legacy = normalizeControlCapabilities({
    capabilities: ['session.identity', 'session.status', 'notification.native'],
  });
  assert.deepEqual(legacy.capabilities, ['session.deliver', 'turn.observe', 'user.notify']);
});

test('workspace roots use path boundaries rather than string prefixes', () => {
  const capabilities = normalizeControlCapabilities({ workspaceRoots: ['/work/team'] });
  assert.equal(assertControlWorkspace(capabilities, '/work/team/project'), '/work/team/project');
  assert.throws(() => assertControlWorkspace(capabilities, '/work/team-other'), /workspace roots/);
});

test('policy and capability inputs reject unknown or malformed values', () => {
  assert.throws(() => normalizeControlCapabilities({ capabilities: ['made-up'] }), /未知宿主能力/);
  assert.throws(() => normalizeControlCapabilities({ policies: ['full-access'] }), /未知策略/);
  const capabilities = normalizeControlCapabilities({ policies: ['read-only'] });
  assert.throws(() => assertControlPolicy(capabilities, 'workspace-write'), /不允许策略/);
});
