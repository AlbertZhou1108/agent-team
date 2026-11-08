import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

const MANIFEST = '.agent-team-skill.json';

function filesUnder(root, current = root) {
  return readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const path = join(current, entry.name);
      return entry.isDirectory() ? filesUnder(root, path) : [path];
    });
}

export function skillContentHash(sourceDir) {
  const skill = join(sourceDir, 'SKILL.md');
  if (!existsSync(skill)) throw new Error('Skill 源目录缺少 SKILL.md');
  const hash = createHash('sha256');
  for (const file of filesUnder(sourceDir)) {
    const name = relative(sourceDir, file).replace(/\\/g, '/');
    if (name === MANIFEST) continue;
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function defaultSkillTarget(host, home = homedir()) {
  if (host === 'codex') return join(home, '.codex', 'skills', 'agent-team');
  if (host === 'claude') return join(home, '.claude', 'skills', 'agent-team');
  return null;
}

export function readSkillManifest(targetDir) {
  try {
    return JSON.parse(readFileSync(join(targetDir, MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

export function skillInstallStatus({ sourceDir, targetDir, version, protocolVersion }) {
  const contentHash = skillContentHash(sourceDir);
  const manifest = readSkillManifest(targetDir);
  return {
    installed: Boolean(manifest),
    current: Boolean(
      manifest
      && manifest.contentHash === contentHash
      && manifest.version === version
      && manifest.protocolVersion === protocolVersion
    ),
    contentHash,
    manifest,
    targetDir,
  };
}

/**
 * 版本化安装 Skill。已有未识别目录不会静默覆盖：先移动到同级可恢复备份，
 * 再用 staged copy + rename 切换。备份只包含 Skill 目录，不触碰宿主认证或运行数据。
 */
export function installSkill({
  sourceDir,
  targetDir,
  version,
  protocolVersion,
  now = new Date().toISOString(),
}) {
  if (!targetDir) throw new Error('需要 Skill 安装目录');
  const status = skillInstallStatus({ sourceDir, targetDir, version, protocolVersion });
  if (status.current) return { ...status, changed: false, backup: null };

  const parent = join(targetDir, '..');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const suffix = `${now.replace(/[:.]/g, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const staging = `${targetDir}.tmp-${suffix}`;
  const backup = existsSync(targetDir) ? `${targetDir}.backup-${suffix}` : null;
  try {
    cpSync(sourceDir, staging, {
      recursive: true,
      filter: source => !source.endsWith(MANIFEST),
    });
    writeFileSync(join(staging, MANIFEST), JSON.stringify({
      name: 'agent-team',
      version,
      protocolVersion,
      contentHash: status.contentHash,
      installedAt: now,
    }, null, 2), { mode: 0o600 });
    if (backup) renameSync(targetDir, backup);
    renameSync(staging, targetDir);
  } catch (error) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    if (backup && !existsSync(targetDir) && existsSync(backup)) {
      try { renameSync(backup, targetDir); } catch { /* preserve original error */ }
    }
    throw error;
  }
  return { ...skillInstallStatus({ sourceDir, targetDir, version, protocolVersion }), changed: true, backup };
}
