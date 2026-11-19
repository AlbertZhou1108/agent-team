// 统一能力清单与角色推导（ADR 0009）：声明归一化、角色推导、主控能力推导。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_IDS,
  CAPABILITY_GROUPS,
  normalizeDeclaration,
  hasCapability,
  deriveRoles,
  resolveCapabilities,
  controllerCapabilityIds,
  mergeDeclarations,
  canonicalMemberCapabilityId,
  canonicalMemberCapabilityIds,
  describeDeclaredCapabilities,
} from '../../hosts/capabilities.mjs';
import { HOST_DEFINITIONS } from '../../hosts/definitions.mjs';

test('capability catalog is flat, unique and fully grouped', () => {
  const grouped = Object.values(CAPABILITY_GROUPS).flat();
  assert.equal(grouped.length, 13);
  assert.deepEqual([...CAPABILITY_IDS].sort(), [...grouped].sort());
  assert.equal(new Set(CAPABILITY_IDS).size, CAPABILITY_IDS.length);
  assert.ok(CAPABILITY_IDS.every(id => id.includes('.')));
});

test('an absent declaration normalizes to all false instead of failing', () => {
  const declaration = normalizeDeclaration(undefined);
  assert.equal(CAPABILITY_IDS.every(id => declaration[id] === false), true);
  assert.deepEqual(deriveRoles(declaration), []);
});

test('unknown capability ids and non-boolean values are rejected', () => {
  assert.throws(() => normalizeDeclaration({ 'session.spawn': true, 'session.teleport': true }), /未知能力位/);
  assert.throws(() => normalizeDeclaration({ 'session.spawn': 'yes' }), /必须是布尔值/);
  assert.throws(() => normalizeDeclaration([]), /能力声明必须是对象/);
  assert.throws(() => hasCapability({}, 'exec.teleport'), /未知能力位/);
});

test('partial declarations are filled with false', () => {
  const declaration = normalizeDeclaration({ 'session.deliver': true });
  assert.equal(declaration['session.deliver'], true);
  assert.equal(declaration['session.spawn'], false);
  assert.equal(declaration['exec.read'], false);
});

test('roles derive from delivery, observation and spawn only', () => {
  assert.deepEqual(deriveRoles(normalizeDeclaration({ 'session.deliver': true, 'turn.observe': true })), ['controller']);
  assert.deepEqual(deriveRoles(normalizeDeclaration({ 'session.wake': true, 'turn.observe': true })), []);
  assert.deepEqual(deriveRoles(normalizeDeclaration({ 'session.spawn': true })), ['member']);
  assert.deepEqual(deriveRoles(normalizeDeclaration({ 'exec.read': true })), []);
  assert.deepEqual(deriveRoles(normalizeDeclaration({})), []);
});

test('spawn and wake come from factory and driver, never from the declaration', () => {
  const caps = resolveCapabilities({
    declaration: { 'session.deliver': true, 'turn.observe': true, 'session.spawn': true, 'session.wake': true },
    hasFactory: false,
    hasWake: false,
  });
  assert.equal(caps['session.spawn'], false);
  assert.equal(caps['session.wake'], false);
  assert.deepEqual(deriveRoles(caps), ['controller']);
});

test('a host without session.spawn is never a member', () => {
  const roles = deriveRoles(normalizeDeclaration({ 'session.deliver': true, 'turn.observe': true }));
  assert.equal(roles.includes('member'), false);
});

test('builtin hosts declare a complete catalog and derive expected roles', () => {
  const expected = {
    codex: ['controller', 'member'],
    claude: ['controller', 'member'],
    dsh: ['controller', 'member'],
    zcode: ['controller', 'member'],
    workbuddy: ['controller'],
  };
  for (const [name, definition] of HOST_DEFINITIONS) {
    assert.equal(Object.keys(definition.capabilities).sort().join(','), [...CAPABILITY_IDS].sort().join(','), `${name} declaration is complete`);
    assert.deepEqual(deriveRoles(definition.capabilities), expected[name], `${name} roles`);
  }
});

test('claude declares no wake while the other builtin hosts do', () => {
  assert.equal(HOST_DEFINITIONS.get('claude').capabilities['session.wake'], false);
  for (const name of ['codex', 'dsh', 'zcode']) {
    assert.equal(HOST_DEFINITIONS.get(name).capabilities['session.wake'], true, name);
  }
});

test('user.notify stays false everywhere without invalidating the catalog', () => {
  for (const [, definition] of HOST_DEFINITIONS) {
    assert.equal(definition.capabilities['user.notify'], false);
  }
  assert.equal(CAPABILITY_IDS.includes('user.notify'), true);
});

test('controller capability ids follow the declaration', () => {
  for (const name of ['codex', 'dsh', 'zcode']) {
    const ids = controllerCapabilityIds(HOST_DEFINITIONS.get(name).capabilities);
    assert.ok(ids.includes('session.deliver'), name);
    assert.ok(ids.includes('session.wake'), name);
    assert.ok(ids.includes('turn.observe'), name);
  }
  const claude = controllerCapabilityIds(HOST_DEFINITIONS.get('claude').capabilities);
  assert.ok(claude.includes('session.deliver'));
  assert.equal(claude.includes('session.wake'), false);
  assert.deepEqual(controllerCapabilityIds(normalizeDeclaration({ 'exec.read': true })), []);
});

test('mergeDeclarations unions positions', () => {
  const merged = mergeDeclarations({ 'exec.read': true }, { 'session.deliver': true }, undefined);
  assert.equal(merged['exec.read'], true);
  assert.equal(merged['session.deliver'], true);
  assert.equal(merged['exec.write'], false);
});

test('legacy member capability ids normalize, and boundary folds into write', () => {
  assert.deepEqual(
    canonicalMemberCapabilityIds(['file.read', 'file.write', 'filesystem.boundary', 'shell.exec']),
    ['exec.read', 'exec.write', 'exec.shell'],
  );
  assert.equal(canonicalMemberCapabilityId('filesystem.boundary'), 'exec.write');
  assert.deepEqual(canonicalMemberCapabilityIds(undefined), []);
  assert.deepEqual(canonicalMemberCapabilityIds(['exec.read', 'exec.read']), ['exec.read']);
  assert.deepEqual(canonicalMemberCapabilityIds(['made-up']), ['made-up']);
});

test('failure attribution names declared capabilities without claiming cause', () => {
  assert.equal(describeDeclaredCapabilities([]), '');
  assert.equal(describeDeclaredCapabilities(undefined), '');
  assert.equal(
    describeDeclaredCapabilities(['exec.read', 'exec.write']),
    '（宿主声明支持: exec.read, exec.write）',
  );
});
