// 用户可见的应用状态投影(计划 §3.1):每个受支持应用一行,
// state ∈ available | pull-only | unavailable,诊断细节按检查项展开。
// 不引入第二种产品级连接流:主控/引擎的失败只作为 diagnostics 出现。
import * as externalAgg from '../aggregates/external-control.mjs';
import { DESKTOP_DEFINITIONS } from './definitions.mjs';

function parseDiagnostics(row) {
  if (!row?.diagnostics) return null;
  try {
    return JSON.parse(row.diagnostics);
  } catch {
    return { summary: row.diagnostics };
  }
}

export function desktopApplicationStatus(store, { definitions = DESKTOP_DEFINITIONS } = {}) {
  return [...definitions.entries()].map(([kind, definition]) => {
    const row = externalAgg.applicationForKind(store, kind);
    if (!row) {
      return {
        kind,
        label: definition.label,
        installed: false,
        state: 'unavailable',
        reason: '未检测到应用安装',
        applicationId: null,
      };
    }
    const diagnostics = parseDiagnostics(row);
    const base = {
      kind,
      label: definition.label,
      installed: true,
      applicationId: row.id,
      installPath: row.install_path,
      bundleVersion: row.bundle_version,
      enginePath: row.engine_path,
      engineVersion: row.engine_version,
      verifiedAt: row.verified_at,
      userDisabled: Boolean(row.user_disabled),
      lifecycleNote: row.lifecycle_note,
      diagnostics,
    };
    if (row.user_disabled) {
      return { ...base, state: 'unavailable', reason: row.disabled_reason ?? '用户已停用该应用' };
    }
    if (row.readiness === 'available') {
      return {
        ...base,
        state: row.pull_only ? 'pull-only' : 'available',
        reason: row.pull_only ? '可用；主动唤醒不可用，仅手动查看消息' : null,
      };
    }
    return {
      ...base,
      state: 'unavailable',
      reason: diagnostics?.summary ?? row.controller_state ?? '尚未通过验证',
    };
  });
}
