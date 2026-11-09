import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_CAPABILITIES,
  assertControlPolicy,
  assertControlWorkspace,
  assertControllerCapabilities,
  effectiveControlCapabilities,
  normalizeControlCapabilities,
} from '../../control-capabilities.mjs';

test('controller capabilities require identity, delivery and observation', () => {
  assert.throws(
    () => assertControllerCapabilities({
      capabilities: [CONTROL_CAPABILITIES.sessionIdentity, CONTROL_CAPABILITIES.messageDelivery],
    }),
    /session\.status/,
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

test('effective capabilities are the intersection of declaration and probe', () => {
  const value = effectiveControlCapabilities({
    capabilities: Object.values(CONTROL_CAPABILITIES),
    workspaceRoots: ['/one', '/two'],
    policies: ['read-only', 'workspace-write'],
  }, {
    capabilities: [CONTROL_CAPABILITIES.sessionIdentity, CONTROL_CAPABILITIES.messageDelivery],
    workspaceRoots: ['/two'],
    policies: ['read-only'],
  });
  assert.deepEqual(value.capabilities, [
    CONTROL_CAPABILITIES.messageDelivery,
    CONTROL_CAPABILITIES.sessionIdentity,
  ]);
  assert.deepEqual(value.workspaceRoots, ['/two']);
  assert.deepEqual(value.policies, ['read-only']);
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
