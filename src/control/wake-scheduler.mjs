/**
 * 外部主控主动唤醒调度：退避常量、wake 状态推导，以及唤醒派发/失败收尾。
 *
 * `wakeStatus` 依赖 `bindingCapabilities`，故单向依赖 `identity.mjs`；`identity.mjs`
 * 反向经 `control.scheduleWake(...)` 委托，不 import 本模块（避免循环）。
 * 原 `ControlPlane` 方法抽成首参 `control` 的模块函数后，类保留同名委托；
 * `wake` / `wakeSchedules` / `wakeInFlight` 仍读 class 实例属性。
 */
import { CONTROL_CAPABILITIES } from '../control-capabilities.mjs';
import * as externalAgg from '../aggregates/external-control.mjs';
import { wakeDriverFor } from '../host-runtime/wake-drivers.mjs';
import { bindingCapabilities } from './identity.mjs';

const WAKE_BACKOFF_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000]);

/** 主动唤醒失败后的退避间隔；超过三次返回 null（由 attempts 阈值转永久降级）。 */
export function wakeBackoffMs(attempts) {
  return WAKE_BACKOFF_MS[attempts - 1] ?? null;
}

export function wakeStatus(binding) {
  if (!binding.session) {
    return { state: 'unsupported', mode: binding.wake_mode ?? binding.host, reason: '尚未发现可恢复的宿主 session' };
  }
  if (binding.pull_only_accepted) {
    return {
      state: 'degraded',
      mode: binding.wake_mode ?? binding.host,
      reason: binding.wake_reason ?? '用户已接受仅拉取模式',
    };
  }
  if (!bindingCapabilities(binding).capabilities.includes(CONTROL_CAPABILITIES.sessionWake)) {
    return { state: 'unsupported', mode: null, reason: '客户端未声明 session.wake，使用仅拉取模式' };
  }
  if (!wakeDriverFor(binding.host)) {
    return { state: 'unsupported', mode: binding.wake_mode ?? binding.host, reason: `宿主 ${binding.host} 尚未实现主动唤醒` };
  }
  if (binding.wake_state === 'ready') {
    return { state: 'ready', mode: binding.wake_mode ?? binding.host, reason: null };
  }
  if (binding.wake_state === 'degraded') {
    return {
      state: 'degraded',
      mode: binding.wake_mode ?? binding.host,
      reason: binding.wake_reason ?? '主动唤醒当前不可用',
    };
  }
  if (binding.wake_state === 'provisioning') {
    return {
      state: 'provisioning',
      mode: binding.wake_mode ?? binding.host,
      reason: binding.wake_reason ?? '正在验证主动唤醒',
    };
  }
  if (binding.wake_state === 'unsupported') {
    return {
      state: 'unsupported',
      mode: binding.wake_mode ?? binding.host,
      reason: binding.wake_reason ?? '宿主不支持主动唤醒',
    };
  }
  if (!binding.wake_config) {
    return { state: 'unverified', mode: binding.host, reason: '尚未建立主动唤醒配置' };
  }
  return {
    state: 'unverified',
    mode: binding.wake_mode ?? binding.host,
    reason: binding.wake_reason ?? '尚未通过真实主动唤醒验证',
  };
}

/**
 * 接管后尽力唤醒旧主控(ADR 0010):让它有机会得知自己已只读。
 * 只是通知,不重试不调度;失败不打断接管本身。
 */
export function wakePreviousController(control, previousBindingId, group) {
  if (!previousBindingId) return;
  const previous = externalAgg.binding(control.bus.store, previousBindingId);
  if (!previous?.session) return;
  Promise.resolve()
    .then(() => control.wake(previous, {
      teamName: `${group.name}（主控已移交）`,
      count: 0,
      workspace: group.workspace,
    }))
    .catch(error => {
      if (!control.bus.closing) console.error('[control] 唤醒前任主控失败:', error.message);
    });
}

export function scheduleWake(control, principalId, groupId) {
  const key = principalId;
  let state = control.wakeSchedules.get(key);
  if (!state) {
    state = { timer: null, groups: new Set() };
    control.wakeSchedules.set(key, state);
  }
  state.groups.add(groupId);
  if (state.timer || control.wakeInFlight.has(key)) return;
  const run = async () => {
    state.timer = null;
    const nextGroup = state.groups.values().next().value;
    if (!nextGroup || control.wakeInFlight.has(key)) return;
    state.groups.delete(nextGroup);
    control.wakeInFlight.add(key);
    try {
      await control.wakePending(principalId, nextGroup);
    } catch (error) {
      if (!control.bus.closing) console.error('[control] 外部唤醒调度失败:', error.message);
    } finally {
      control.wakeInFlight.delete(key);
      if (state.groups.size) {
        const remaining = state.groups.values().next().value;
        control.scheduleWake(principalId, remaining);
      }
      else control.wakeSchedules.delete(key);
    }
  };
  state.timer = setTimeout(run, 25);
  state.timer.unref?.();
}

export async function wakePending(control, principalId, groupId) {
  if (control.bus.closing) return { state: 'closed' };
  const binding = externalAgg.activeBindingForTeam(control.bus.store, principalId, groupId);
  const rows = externalAgg.pendingWakes(control.bus.store, principalId, groupId);
  if (!rows.length) return { state: 'empty' };
  if (!binding) {
    externalAgg.markWake(control.bus.store, rows.map(row => row.id), {
      state: 'unsupported',
      error: 'active controller binding 不存在或已禁用',
    });
    return { state: 'unsupported', count: rows.length };
  }
  if (binding.wake_next_attempt && Date.parse(binding.wake_next_attempt) > Date.now()) {
    return { state: 'backoff', nextAttempt: binding.wake_next_attempt };
  }
  if (Number(binding.wake_attempts ?? 0) >= 3 && binding.wake_state !== 'ready') {
    return { state: 'degraded', reason: binding.wake_reason ?? '主动唤醒连续失败' };
  }
  if (binding.pull_only_accepted) {
    return { state: 'unsupported', count: rows.length, reason: 'binding 已接受仅拉取模式' };
  }
  externalAgg.markWake(control.bus.store, rows.map(row => row.id), {
    bindingId: binding.id,
    state: 'sending',
  });
  const group = control.bus.store.group(groupId);
  const teamName = group.name;
  try {
    const result = await control.wake(binding, {
      teamName,
      count: rows.length,
      workspace: group.workspace,
    });
    if (!result.supported) {
      externalAgg.markWake(control.bus.store, rows.map(row => row.id), {
        bindingId: binding.id,
        state: 'unsupported',
        error: result.reason ?? '宿主不支持主动唤醒',
      });
      externalAgg.setBindingWakeState(control.bus.store, binding.id, {
        state: 'unsupported',
        mode: binding.host,
        reason: result.reason ?? '宿主不支持主动唤醒',
      });
      return { state: 'unsupported', count: rows.length, reason: result.reason };
    }
    if (result.state === 'failed') {
      control.recordWakeFailure({
        binding,
        principalId,
        groupId,
        messageIds: rows.map(row => row.id),
        reason: result.reason ?? '主动唤醒失败',
        mode: result.mode ?? binding.host,
        fingerprint: result.fingerprint ?? null,
      });
      return { state: 'error', count: rows.length, reason: result.reason };
    }
    const now = new Date().toISOString();
    externalAgg.markWake(control.bus.store, rows.map(row => row.id), {
      bindingId: binding.id,
      state: 'sent',
    });
    externalAgg.setBindingWakeState(control.bus.store, binding.id, {
      state: (result.state ?? 'started') === 'started' ? 'ready' : 'provisioning',
      mode: result.mode ?? binding.host,
      reason: result.state === 'queued' ? '队列已接受，等待宿主开始回合' : null,
      fingerprint: result.fingerprint ?? null,
      verifiedAt: result.state === 'queued' ? null : now,
      attempts: 0,
      nextAttempt: null,
      now,
    });
    return { state: 'sent', count: rows.length };
  } catch (error) {
    control.recordWakeFailure({
      binding,
      principalId,
      groupId,
      messageIds: rows.map(row => row.id),
      reason: error.message,
    });
    return { state: 'error', count: rows.length, reason: error.message };
  }
}

/**
 * 主动唤醒失败的统一收尾：标记消息、降级 binding、按次数安排有界退避。
 *
 * 适配器"返回失败"（例如会话写锁被占用）与"抛异常"走同一条路径——
 * 两者都是暂时性失败，都应退避后重试，而不是只有异常才重试。
 * 第三次失败后由 wakePending 的 attempts 阈值转永久降级。
 */
export function recordWakeFailure(control, { binding, principalId, groupId, messageIds, reason, mode = binding.host, fingerprint = null }) {
  const attempts = Number(binding.wake_attempts ?? 0) + 1;
  const backoff = wakeBackoffMs(attempts);
  const nextAttempt = backoff == null ? null : new Date(Date.now() + backoff).toISOString();
  externalAgg.markWake(control.bus.store, messageIds, {
    bindingId: binding.id,
    state: 'error',
    error: reason,
  });
  externalAgg.setBindingWakeState(control.bus.store, binding.id, {
    state: 'degraded',
    mode,
    reason: attempts >= 3 ? `主动唤醒连续失败：${reason}` : reason,
    fingerprint,
    attempts,
    nextAttempt,
  });
  if (backoff != null) {
    const timer = setTimeout(() => {
      control.scheduleWake(principalId, groupId);
    }, backoff);
    timer.unref?.();
  }
  return { attempts, backoff, nextAttempt };
}
