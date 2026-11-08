import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSkillTarget,
  installSkill,
  readSkillManifest,
  skillInstallStatus,
} from '../../src/skill-install.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-skill-'));
  const source = join(root, 'source');
  const target = join(root, 'home', '.codex', 'skills', 'agent-team');
  mkdirSync(join(source, 'references'), { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), '# Agent Team\n');
  writeFileSync(join(source, 'references', 'lead.md'), 'lead\n');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { root, source, target };
}

test('known hosts resolve stable Skill directories', () => {
  assert.equal(defaultSkillTarget('codex', '/home/u'), join('/home/u', '.codex', 'skills', 'agent-team'));
  assert.equal(defaultSkillTarget('claude', '/home/u'), join('/home/u', '.claude', 'skills', 'agent-team'));
  assert.equal(defaultSkillTarget('other', '/home/u'), null);
});

test('install writes a manifest, is idempotent and upgrades with a recoverable backup', t => {
  const { source, target } = fixture(t);
  const first = installSkill({
    sourceDir: source,
    targetDir: target,
    version: '1.0.0',
    protocolVersion: 1,
    now: '2026-11-08T00:00:00.000Z',
  });
  assert.equal(first.changed, true);
  assert.equal(first.backup, null);
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), '# Agent Team\n');
  assert.equal(readSkillManifest(target).version, '1.0.0');

  const second = installSkill({
    sourceDir: source,
    targetDir: target,
    version: '1.0.0',
    protocolVersion: 1,
  });
  assert.equal(second.changed, false);

  writeFileSync(join(source, 'SKILL.md'), '# Agent Team v2\n');
  const upgraded = installSkill({
    sourceDir: source,
    targetDir: target,
    version: '1.1.0',
    protocolVersion: 1,
    now: '2026-11-08T00:01:00.000Z',
  });
  assert.equal(upgraded.changed, true);
  assert.ok(upgraded.backup);
  assert.equal(readFileSync(join(upgraded.backup, 'SKILL.md'), 'utf8'), '# Agent Team\n');
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), '# Agent Team v2\n');
  assert.equal(
    skillInstallStatus({ sourceDir: source, targetDir: target, version: '1.1.0', protocolVersion: 1 }).current,
    true,
  );
});

test('an unmanaged existing directory is backed up instead of overwritten silently', t => {
  const { source, target } = fixture(t);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'custom.txt'), 'keep me\n');
  const installed = installSkill({
    sourceDir: source,
    targetDir: target,
    version: '1.0.0',
    protocolVersion: 1,
  });
  assert.ok(installed.backup);
  assert.equal(readFileSync(join(installed.backup, 'custom.txt'), 'utf8'), 'keep me\n');
  assert.equal(readSkillManifest(target).name, 'agent-team');
});
