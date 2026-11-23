// 桌面应用检测:文件系统探测 + 平台无关版本发现 + 指纹,与注册表同步。
// 检测是廉价的文件系统/版本查询,不消耗模型额度; readiness 只能由验证改变,
// 但「安装或引擎指纹变化」会把既有 available 翻回 unavailable(ADR 0011:先重验证再开工)。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import * as externalAgg from '../aggregates/external-control.mjs';
import { runCommand } from '../host-runtime/lifecycle.mjs';
import { DESKTOP_DEFINITIONS } from './definitions.mjs';

const MSIX_REGISTRY_KEY = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_ASAR_HEADER_BYTES = 16 * 1024 * 1024;

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))];
}

function defaultApplicationsRoots(platform, home, env) {
  if (platform === 'darwin') {
    return ['/Applications', join(home, 'Applications')];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return uniqueStrings([
      join(local, 'Programs'),
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      local,
    ]);
  }
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return uniqueStrings(['/opt', '/usr/lib', '/usr/share', data]);
}

function defaultSupportRoots(platform, home, env) {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support')];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
    return uniqueStrings([local, roaming]);
  }
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return uniqueStrings([data, config]);
}

export function desktopDetectionContext({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  applicationsRoot,
  applicationsRoots,
  supportRoot,
  supportRoots,
  msixPackages,
} = {}) {
  const explicitApps = applicationsRoots !== undefined || applicationsRoot !== undefined;
  const resolvedAppRoots = applicationsRoots !== undefined
    ? uniqueStrings(applicationsRoots)
    : applicationsRoot !== undefined
      ? uniqueStrings([applicationsRoot])
      : defaultApplicationsRoots(platform, home, env);
  const resolvedSupportRoots = supportRoots !== undefined
    ? uniqueStrings(supportRoots)
    : supportRoot !== undefined
      ? uniqueStrings([supportRoot])
      : defaultSupportRoots(platform, home, env);
  return {
    platform,
    home,
    applicationsRoot: resolvedAppRoots[0] ?? '',
    applicationsRoots: resolvedAppRoots,
    supportRoot: resolvedSupportRoots[0] ?? '',
    supportRoots: resolvedSupportRoots,
    // 显式指定自定义 applicationsRoot(如测试隔离目录)时默认不扫描本机注册表 MSIX 包,
    // 避免真实宿主机安装穿透到测试。
    msixPackages: msixPackages !== undefined ? msixPackages : (explicitApps ? [] : undefined),
  };
}

/**
 * 解析 `reg query HKCU\...\AppModel\Repository\Packages /s /v PackageRootFolder` 输出。
 * 纯函数,跨平台可单测;返回按版本号降序排列的 `{ name, version, root }` 列表。
 */
export function parseWindowsMsixRegistryOutput(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return [];
  const packages = [];
  let currentName = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('HKEY_')) {
      const idx = line.lastIndexOf('\\');
      currentName = idx >= 0 ? line.slice(idx + 1) : null;
      continue;
    }
    if (!currentName) continue;
    const match = /^PackageRootFolder\s+REG_\w+\s+(.+)$/i.exec(line);
    if (!match) continue;
    const root = match[1].trim();
    const versionMatch = /_(\d+\.\d+\.\d+\.\d+)_/.exec(currentName);
    packages.push({ name: currentName, version: versionMatch?.[1] ?? '0.0.0.0', root });
    currentName = null;
  }
  return packages.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

function discoverWindowsMsixPackages({ timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    try {
      execFile('reg.exe', ['query', MSIX_REGISTRY_KEY, '/s', '/v', 'PackageRootFolder'], {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout) => {
        if (error && !stdout) return resolve([]);
        resolve(parseWindowsMsixRegistryOutput(String(stdout ?? '')));
      });
    } catch {
      resolve([]);
    }
  });
}

function readSmallText(filePath, maxBytes = MAX_METADATA_BYTES) {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size === 0 || stats.size > maxBytes) return null;
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJsonVersion(filePath) {
  const text = readSmallText(filePath);
  if (!text) return null;
  try {
    const version = JSON.parse(text)?.version;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 纯 Node 读取 Electron `.asar` 归档头中的 `package.json` 版本号,不解压、零外部依赖。
 * ASAR 格式(Chromium Pickle):
 * - bytes 0..3: size pickle payload size (=4)
 * - bytes 4..7: header pickle total size
 * - bytes 8..11: header pickle payload size
 * - bytes 12..15: JSON 字符串字节长度
 * - bytes 16..(16 + jsonLen): UTF-8 JSON 目录索引
 * - dataOffset = 8 + headerPickleTotalSize
 */
export function readAsarPackageVersion(asarPath) {
  let fd;
  try {
    const stats = statSync(asarPath);
    if (!stats.isFile() || stats.size < 20) return null;
    fd = openSync(asarPath, 'r');
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) !== 16) return null;
    const headerPickleSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    if (jsonLength === 0 || jsonLength > MAX_ASAR_HEADER_BYTES || 16 + jsonLength > stats.size) return null;
    const headerBuf = Buffer.alloc(jsonLength);
    if (readSync(fd, headerBuf, 0, jsonLength, 16) !== jsonLength) return null;
    const header = JSON.parse(headerBuf.toString('utf8'));
    const entry = header?.files?.['package.json'];
    if (!entry || typeof entry.size !== 'number' || entry.size <= 0 || entry.size > MAX_METADATA_BYTES) return null;
    if (entry.unpacked === true || entry.offset === undefined) return null;
    const dataOffset = 8 + headerPickleSize + Number(entry.offset);
    if (!Number.isSafeInteger(dataOffset) || dataOffset < 0 || dataOffset + entry.size > stats.size) return null;
    const content = Buffer.alloc(entry.size);
    if (readSync(fd, content, 0, entry.size, dataOffset) !== entry.size) return null;
    const version = JSON.parse(content.toString('utf8'))?.version;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readPlistVersion(plistPath) {
  const text = readSmallText(plistPath);
  if (!text || text.startsWith('bplist')) return null;
  const shortMatch = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/.exec(text);
  if (shortMatch?.[1]) return shortMatch[1].trim();
  const buildMatch = /<key>\s*CFBundleVersion\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/.exec(text);
  return buildMatch?.[1]?.trim() ?? null;
}

function readAppxManifestVersion(manifestPath) {
  const text = readSmallText(manifestPath);
  if (!text) return null;
  const match = /<Identity\b[^>]*\bVersion\s*=\s*"([^"]+)"/i.exec(text);
  return match?.[1]?.trim() ?? null;
}

function readPlainVersionFile(versionPath) {
  const text = readSmallText(versionPath, 4096);
  if (!text) return null;
  const line = text.split(/\r?\n/).map(item => item.trim()).find(Boolean);
  return line && /^v?\d+(?:\.\d+)+(?:[-+._][A-Za-z0-9]+)*$/.test(line) ? line : null;
}

function readDirectoryNameVersion(bundlePath) {
  const name = basename(bundlePath);
  const appDir = /^app-(\d+(?:\.\d+)+)$/.exec(name);
  if (appDir?.[1]) return appDir[1];
  const msixDir = /_(\d+\.\d+\.\d+\.\d+)_/.exec(name);
  return msixDir?.[1] ?? null;
}

/**
 * 平台无关的 bundle 版本读取:按元数据文件格式依次提取(JSON 清单 → Electron app.asar →
 * XML Info.plist / AppxManifest.xml → 纯文本 version 文件 → 版本目录名),
 * 不依赖平台分支或外部系统命令(plutil / PowerShell);提取不到返回 null,不阻断检测。
 */
export async function readBundleVersion(bundlePath) {
  const jsonCandidates = [
    join(bundlePath, 'package.json'),
    join(bundlePath, 'resources', 'app', 'package.json'),
    join(bundlePath, 'app', 'resources', 'app', 'package.json'),
    join(bundlePath, 'Contents', 'Resources', 'app', 'package.json'),
  ];
  for (const file of jsonCandidates) {
    const version = readJsonVersion(file);
    if (version) return version;
  }

  const asarCandidates = [
    join(bundlePath, 'resources', 'app.asar'),
    join(bundlePath, 'app', 'resources', 'app.asar'),
    join(bundlePath, 'Contents', 'Resources', 'app.asar'),
  ];
  for (const file of asarCandidates) {
    const version = readAsarPackageVersion(file);
    if (version) return version;
  }

  const plistVersion = readPlistVersion(join(bundlePath, 'Contents', 'Info.plist'));
  if (plistVersion) return plistVersion;

  const appxVersion = readAppxManifestVersion(join(bundlePath, 'AppxManifest.xml'));
  if (appxVersion) return appxVersion;

  const plainVersion = readPlainVersionFile(join(bundlePath, 'version'));
  if (plainVersion) return plainVersion;

  return readDirectoryNameVersion(bundlePath);
}

const WINDOWS_EXECUTABLE_EXT = /\.(?:exe|cmd|bat|com)$/i;
const JS_MODULE_EXT = /\.(?:c|m)?js$/i;

/**
 * 默认引擎版本探测:经 spawnHost(自动兼容 Windows .cmd shim)执行引擎自报版本;失败视为版本未知,不阻断检测。
 * Windows 下只对真正的可执行扩展名(.exe/.cmd/.bat/.com)发起探测,绝不把 .cjs 等非可执行文件交给
 * cross-spawn/cmd.exe(否则会触发 Windows 文件关联「选取应用」弹窗)。
 */
async function probeEngineVersion(enginePath, args) {
  if (!Array.isArray(args)) return null;
  if (JS_MODULE_EXT.test(enginePath)) return null;
  if (process.platform === 'win32' && !WINDOWS_EXECUTABLE_EXT.test(enginePath)) return null;
  try {
    const stdout = await runCommand(enginePath, args, 10_000);
    return stdout ? stdout.split(/\r?\n/)[0].trim() : null;
  } catch {
    return null;
  }
}

export function detectionFingerprint({ kind, bundlePath, bundleVersion, enginePath, engineVersion }) {
  return createHash('sha256')
    .update(JSON.stringify({ kind, surface: 'desktop', bundlePath, bundleVersion, enginePath, engineVersion }))
    .digest('hex');
}

async function detectKind(definition, context, { readBundleVersion: readVersion = readBundleVersion } = {}) {
  const existingBundles = definition.bundleCandidates(context).filter(path => {
    if (!existsSync(path)) return false;
    return typeof definition.isValidBundle === 'function' ? definition.isValidBundle(path) : true;
  });
  if (!existingBundles.length) return { found: false };

  // 多个目录同时存在时(例如旧安装残留空壳 + 真实安装目录),优先选带真实内嵌引擎的那一个。
  let selectedBundle = existingBundles[0];
  let selectedEngine = null;
  for (const candidateBundle of existingBundles) {
    const engine = definition.engineCandidates({ ...context, bundlePath: candidateBundle })
      .find(candidate => existsSync(candidate.path)) ?? null;
    if (engine) {
      selectedBundle = candidateBundle;
      selectedEngine = engine;
      break;
    }
  }

  const bundleVersion = await readVersion(selectedBundle);
  const versionArgs = definition.engineVersionArgs === undefined ? ['--version'] : definition.engineVersionArgs;
  const engineVersion = selectedEngine
    ? (selectedEngine.version ?? await probeEngineVersion(selectedEngine.path, versionArgs))
    : null;
  return {
    found: true,
    bundlePath: selectedBundle,
    bundleVersion,
    enginePath: selectedEngine?.path ?? null,
    engineVersion,
  };
}

/**
 * 检测并把结果同步进注册表。返回每个受支持 kind 的一条检测结论:
 * found=false 的 kind 只有在注册表里已有旧行时才会被标记 unavailable(卸载语义:
 * 记录保留、新工作停止);从未安装过的 kind 不产生行。三平台走统一注册逻辑。
 */
export async function detectDesktopApplications(store, {
  definitions = DESKTOP_DEFINITIONS,
  context = desktopDetectionContext(),
  readBundleVersion: readVersion = readBundleVersion,
} = {}) {
  const resolvedContext = context.platform === 'win32' && context.msixPackages === undefined
    ? { ...context, msixPackages: await discoverWindowsMsixPackages() }
    : context;
  const results = [];
  for (const [kind, definition] of definitions) {
    const detected = await detectKind(definition, resolvedContext, { readBundleVersion: readVersion });
    results.push({ kind, ...detected, ...syncDetection(store, kind, detected) });
  }
  return results;
}

function syncDetection(store, kind, detected) {
  const existing = externalAgg.applicationForKind(store, kind);
  if (!detected.found) {
    if (!existing) return { registered: false };
    // 卸载语义:行保留,新工作停止;即使已是 unavailable 也刷新原因,让状态解释当前事实。
    externalAgg.setApplicationVerification(store, existing.id, {
      readiness: 'unavailable',
      diagnostics: { summary: '应用未检测到；团队与记录保留，重新检测到并完成验证后恢复' },
      verifiedAt: null,
    });
    return { registered: true, revalidated: false };
  }
  const fingerprint = detectionFingerprint({ kind, ...detected });
  const id = existing?.id
    ?? `desktop-${kind}-${createHash('sha256').update(detected.bundlePath).digest('hex').slice(0, 12)}`;
  externalAgg.upsertApplication(store, {
    id,
    kind,
    surface: 'desktop',
    installPath: detected.bundlePath,
    bundleVersion: detected.bundleVersion,
    enginePath: detected.enginePath,
    engineVersion: detected.engineVersion,
    fingerprint,
    created: existing?.created ?? new Date().toISOString(),
  });
  const current = externalAgg.application(store, id);
  let revalidated = false;
  if (current.readiness === 'available') {
    const engineLost = Boolean(current.engine_path) && !detected.enginePath;
    const fingerprintChanged = Boolean(existing?.fingerprint) && existing.fingerprint !== fingerprint;
    if (engineLost || fingerprintChanged) {
      externalAgg.setApplicationVerification(store, id, {
        readiness: 'unavailable',
        diagnostics: {
          summary: engineLost
            ? '内嵌执行引擎不再存在；需要重新验证后才能恢复新工作'
            : '应用或引擎的安装指纹已变化；需要重新验证后才能恢复新工作',
        },
        verifiedAt: null,
      });
      revalidated = true;
    }
  }
  return { registered: true, revalidated, fingerprint, applicationId: id, created: !existing };
}
