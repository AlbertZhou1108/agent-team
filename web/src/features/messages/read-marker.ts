import { provide, inject, type InjectionKey } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';

/**
 * 读水位的唯一前端入口。
 *
 * 什么时候算读过由滚动容器决定（最后一条进入视口 / 停在底部时新消息到达），
 * 本模块只负责：窗口可见且聚焦才提交、同一会话只许前进、提交后刷新工作台。
 */

export type ReadScope = 'group' | 'panel';

/** 会话滚到底时通知外层记账；由工作区 provide，滚动容器 inject。 */
export const reachBottomKey: InjectionKey<() => void> = Symbol('reach-bottom');

export function provideReachBottom(handler: () => void) {
  provide(reachBottomKey, handler);
}

export function injectReachBottom(): (() => void) | null {
  return inject(reachBottomKey, null);
}

/** 窗口隐藏或失焦时不提交：页面还在拉数据，但人没看。 */
export function canMarkRead() {
  return (
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    document.hasFocus()
  );
}

export function useReadMarker() {
  const client = useQueryClient();
  const sent = new Map<string, number>();
  return async function markRead(scope: ReadScope, scopeId: string, seq: number) {
    if (!Number.isInteger(seq) || seq <= 0 || !canMarkRead()) return;
    const key = `${scope}:${scopeId}`;
    if (seq <= (sent.get(key) ?? 0)) return;
    sent.set(key, seq);
    try {
      await api.advanceRead({ scope, scopeId, seq });
      await client.invalidateQueries({ queryKey: ['workbench'] });
    } catch {
      // 提交失败就忘掉这次记录，下次滚到底还能重试。
      sent.delete(key);
    }
  };
}
