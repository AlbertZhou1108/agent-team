// 桌面应用检测:文件系统探测 + 版本发现 + 指纹,与注册表同步。
// 检测是廉价的文件系统/版本查询,不消耗模型额度; readiness 只能由验证改变,
// 但「安装或引擎指纹变化」会把既有 available 翻回 unavailable(ADR 0011:先重验证再开工)。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as externalAgg from '../aggregates/external-control.mjs';
import { DESKTOP_DEFINITIONS } from './definitions.mjs';

export function desktopDetectionContext({
  platform = process.platform,
  applicationsRoot = '/Applications',
  supportRoot = join(homedir(), 'Library', 'Application Support'),
} = {}) {
  return { platform, applicationsRoot, supportRoot };
}

function runOnce(command, args, { timeoutMs = 10_000 } = {}) {
  return new Promise(resolve => {
    try {
      execFile(command, args, { timeout: timeoutMs }, (error, stdout) => {
        resolve(error ? null : String(stdout).trim());
      });
    } catch {
      resolve(null);
    }
  });
}

/** 默认 bundle 版本读取:macOS 用 plutil 转 JSON;其它平台返回 null(路径存在性仍可用)。 */
export async function readBundleVersion(bundlePath) {
  if (process.platform !== 'darwin') return null;
  const stdout = await runOnce('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')]);
  if (!stdout) return null;
  try {
    return JSON.parse(stdout)?.CFBundleShortVersionString ?? null;
  } catch {
    return null;
  }
}

/** 默认引擎版本探测:执行引擎自报版本;失败视为版本未知,不阻断检测。 */
async function probeEngineVersion(enginePath, args) {
  const stdout = await runOnce(enginePath, args);
  return stdout ? stdout.split('\n')[0].trim() : null;
}

export function detectionFingerprint({ kind, bundlePath, bundleVersion, enginePath, engineVersion }) {
  return createHash('sha256')
    .update(JSON.stringify({ kind, surface: 'desktop', bundlePath, bundleVersion, enginePath, engineVersion }))
    .digest('hex');
}

async function detectKind(definition, context, { readBundleVersion: readVersion = readBundleVersion } = {}) {
  const bundlePath = definition.bundleCandidates(context).find(path => existsSync(path)) ?? null;
  if (!bundlePath) return { found: false };
  const bundleVersion = await readVersion(bundlePath);
  // 引擎候选需要拿到已定位的 bundle 路径(codex/dsh 在 bundle 资源内,claude 在用户数据目录)。
  const engine = definition.engineCandidates({ ...context, bundlePath })
    .find(candidate => existsSync(candidate.path)) ?? null;
  const engineVersion = engine
    ? (engine.version ?? await probeEngineVersion(engine.path, definition.engineVersionArgs ?? ['--version']))
    : null;
  return {
    found: true,
    bundlePath,
    bundleVersion,
    enginePath: engine?.path ?? null,
    engineVersion,
  };
}

/**
 * 检测并把结果同步进注册表。返回每个受支持 kind 的一条检测结论:
 * found=false 的 kind 只有在注册表里已有旧行时才会被标记 unavailable(卸载语义:
 * 记录保留、新工作停止);从未安装过的 kind 不产生行。非 macOS 平台不产生行。
 */
export async function detectDesktopApplications(store, {
  definitions = DESKTOP_DEFINITIONS,
  context = desktopDetectionContext(),
  readBundleVersion: readVersion = readBundleVersion,
} = {}) {
  const results = [];
  for (const [kind, definition] of definitions) {
    const detected = await detectKind(definition, context, { readBundleVersion: readVersion });
    results.push({ kind, ...detected, ...syncDetection(store, kind, detected, context) });
  }
  return results;
}

function syncDetection(store, kind, detected, context) {
  const existing = externalAgg.applicationForKind(store, kind);
  // 首个发布只声明 macOS 支持(ADR 0011);非 macOS 平台不产生注册行,也不翻既有结论。
  if (context.platform !== 'darwin') return { registered: false };
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
