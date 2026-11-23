// 桌面应用验证执行器(计划 §3.2):两项真实检查——主控检查(桌面会话能看见并
// 调用 Agent Team 工具、宿主提供会话身份与工作目录)与引擎检查(内嵌引擎在
// 框架私有的临时存储里完成一个短任务)。编排责任全部在框架:额度确认门、
// 临时目录生命周期、超时看门狗、进程树清理、全有全无结论落库。
// 每个应用的「怎么验」由定义表里的 verify 策略提供,宿主切片填充。
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as externalAgg from '../aggregates/external-control.mjs';
import { spawnHost, stopHost } from '../host-runtime/subprocess.mjs';
import { detectDesktopApplications, desktopDetectionContext } from './detect.mjs';
import { DESKTOP_DEFINITIONS } from './definitions.mjs';

export const VERIFICATION_COST_NOTICE = '验证会创建两个短会话(主控检查与引擎检查),可能消耗该应用账号的少量模型额度;验证产物只写入框架私有目录。';

function stopAll(children) {
  return Promise.allSettled([...children].map(child => stopHost(child)));
}

/**
 * 验证一个桌面应用。confirmed=false 时只返回额度确认请求,不执行任何检查;
 * 确认后运行两项检查,任一失败/超时/不可判定 → unavailable(全有全无)。
 * 返回 { verified, application?, needsConfirmation?, refused?, reason? }。
 */
export async function verifyDesktopApplication(store, kind, {
  confirmed = false,
  definitions = DESKTOP_DEFINITIONS,
  context = desktopDetectionContext(),
  readBundleVersion = undefined,
  socketPath = null,
  timeoutMs = 120_000,
  now = new Date().toISOString(),
} = {}) {
  const definition = definitions.get(kind);
  if (!definition) throw new Error(`未知的桌面应用: ${kind}`);
  const existing = externalAgg.applicationForKind(store, kind);
  if (existing?.user_disabled) {
    return { verified: false, refused: true, reason: existing.disabled_reason ?? '用户已停用该应用', application: existing };
  }
  if (!confirmed) {
    return { verified: false, needsConfirmation: true, cost: VERIFICATION_COST_NOTICE };
  }

  // 检测快照:验证目标必须是当前真实存在的安装。
  const detections = await detectDesktopApplications(store, {
    definitions,
    context,
    ...(readBundleVersion ? { readBundleVersion } : {}),
  });
  const detected = detections.find(item => item.kind === kind && item.found);
  const applicationId = detected?.applicationId ?? existing?.id ?? null;
  if (!detected || !applicationId) {
    if (applicationId) {
      externalAgg.setApplicationVerification(store, applicationId, {
        readiness: 'unavailable',
        diagnostics: { summary: '验证时未检测到应用安装' },
        verifiedAt: null,
      });
    }
    return { verified: false, reason: '未检测到应用安装', application: applicationId ? externalAgg.application(store, applicationId) : null };
  }
  if (!definition.verifyController || !definition.verifyEngine) {
    externalAgg.setApplicationVerification(store, applicationId, {
      readiness: 'unavailable',
      diagnostics: { summary: '该应用的验证策略尚未提供;检测事实已登记' },
      fingerprint: detected.fingerprint,
    });
    return { verified: false, reason: '该应用的验证策略尚未提供', application: externalAgg.application(store, applicationId) };
  }

  // 框架私有临时存储:检查产物只落在这里,任何结束路径都清理。
  const workspace = join(store.directory, 'desktop-verify', randomUUID());
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const children = new Set();
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; stopAll(children); }, timeoutMs);
  watchdog.unref?.();
  const checkContext = {
    store,
    workspace,
    detection: detected,
    definition,
    timeoutMs,
    socketPath: socketPath ?? null,
    spawnTracked: (command, args, options = {}) => {
      // stdin 必须显式 ignore:引擎的 exec 模式在 stdin 为挂起的管道时会一直
      // 等待附加输入(实测 codex exec 卡死的原因);回合输入只走位置参数。
      const child = spawnHost(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
      children.add(child);
      return child;
    },
  };
  try {
    const controller = timedOut
      ? { ok: false, reason: '验证超时' }
      : await safeCheck(() => definition.verifyController?.(checkContext), '主控检查未提供');
    const engine = timedOut
      ? { ok: false, reason: '验证超时' }
      : await safeCheck(() => definition.verifyEngine?.(checkContext), '引擎检查未提供');
    const ok = !timedOut && controller.ok === true && engine.ok === true;
    const pullOnly = ok && controller.wake?.available === false;
    externalAgg.setApplicationVerification(store, applicationId, {
      readiness: ok ? 'available' : 'unavailable',
      pullOnly,
      controllerState: summarizeCheck(controller, timedOut),
      engineState: summarizeCheck(engine, timedOut),
      diagnostics: { controller, engine, timedOut, summary: ok ? '主控与引擎检查均通过' : '验证未通过' },
      fingerprint: detected.fingerprint,
      verifiedAt: now,
      lifecycleNote: definition.lifecycleNote ?? null,
    });
    return { verified: ok, application: externalAgg.application(store, applicationId) };
  } finally {
    clearTimeout(watchdog);
    await stopAll(children);
    try {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows 偶发短暂句柄占用时不覆盖验证返回值。
    }
    // 空的验证根目录也一并清掉;rmdirSync 只在目录为空时成功——
    // 还有并发验证运行时目录非空,抛错即忽略,绝不误删其他运行的工作区。
    try {
      rmdirSync(join(store.directory, 'desktop-verify'));
    } catch {
      // 非空(并发验证仍在进行)或已不存在:保留即可。
    }
  }
}

async function safeCheck(run, missingReason) {
  try {
    return await run() ?? { ok: false, reason: missingReason };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function summarizeCheck(check, timedOut) {
  if (timedOut) return '验证超时';
  if (check.ok === true) return check.reason ?? '通过';
  return check.reason ?? '未通过';
}
