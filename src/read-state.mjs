// 读水位的写入入口：校验「谁在读、读到第几号」，再交给聚合层推进。
// 前端只在窗口可见且停在会话底部时调用；服务端不做任何隐式推断。
import * as readAgg from './aggregates/read-state.mjs';

/** @param {import("./types.mjs").BusRef} bus @param {{scope?: unknown, scopeId?: unknown, seq?: unknown}} input */
export function advanceReadState(bus, input) {
  const scope = String(input?.scope ?? '');
  if (!readAgg.READ_SCOPES.has(scope)) throw new Error('未知的读水位类型');
  const scopeId = typeof input?.scopeId === 'string' ? input.scopeId.trim() : '';
  if (!scopeId || scopeId.length > 200) throw new Error('读水位缺少目标会话');
  const seq = input?.seq;
  if (!Number.isInteger(seq) || seq < 0) throw new Error('读水位序号无效');
  if (scope === 'group') {
    bus.store.group(scopeId);
  } else {
    const agent = bus.panelAgent();
    if (!agent) throw new Error('尚未配置 Panel Agent');
    if (!scopeId.startsWith(`${agent.id}:`)) throw new Error('读水位不属于当前 Panel Agent');
  }
  return { scope, scopeId, seq: readAgg.advance(bus.store, { scope, scopeId, seq }) };
}
