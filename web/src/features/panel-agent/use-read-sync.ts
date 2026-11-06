import {
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type MaybeRefOrGetter,
  toValue,
} from 'vue';
import { usePanelAgentStore } from '@/stores/panel-agent';
import type { MessageView } from '@/shared/models/view-types';
import type { UnreadMessage, UnreadReceipt } from '@/shared/api/raw-types';

export type ReadSyncOptions = {
  /** Panel 私聊消息或团队未读投影。 */
  messages: MaybeRefOrGetter<UnreadMessage[]>;
  /** 等待回复的回执分组。 */
  receipts: MaybeRefOrGetter<Array<{ receipts: UnreadReceipt[] }>>;
  panelRoute: MaybeRefOrGetter<boolean>;
  /** 当前渲染的消息视图，用于判定回执来源是否真正可见。 */
  messageViews: MaybeRefOrGetter<MessageView[]>;
  selectedPair: MaybeRefOrGetter<string>;
};

/**
 * Panel 已读游标同步（与 Pinia 交互的唯一入口）。
 * - 页面可见性（focus/blur/visibilitychange）只服务已读游标，收在这里；
 * - 历史视图打开时不推进全局游标；只有当前展示的回执来源才标记已读。
 */
export function useReadSync(options: ReadSyncOptions) {
  const state = usePanelAgentStore();
  const pageVisible = ref(
    typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      document.hasFocus(),
  );

  function updatePageVisibility() {
    pageVisible.value =
      document.visibilityState === 'visible' && document.hasFocus();
  }

  onMounted(() => {
    window.addEventListener('focus', updatePageVisibility);
    window.addEventListener('blur', updatePageVisibility);
    document.addEventListener('visibilitychange', updatePageVisibility);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('focus', updatePageVisibility);
    window.removeEventListener('blur', updatePageVisibility);
    document.removeEventListener('visibilitychange', updatePageVisibility);
  });

  watch(
    [
      () => toValue(options.messages),
      () => toValue(options.panelRoute),
      pageVisible,
      () => state.historyVisible,
    ],
    ([messages, onGlobal, visible, history]) => {
      state.syncReadContexts(
        messages,
        onGlobal && visible && !history ? '' : undefined,
      );
    },
    { immediate: true },
  );

  watch(
    [
      () => toValue(options.receipts),
      () => toValue(options.messageViews),
      pageVisible,
      () => toValue(options.panelRoute),
      () => state.historyVisible,
    ],
    ([requests, views, visible, onPanel]) => {
      if (!requests) return;
      const pair = toValue(options.selectedPair);
      const displayed =
        !onPanel && visible
          ? views
              .filter((message) => !pair || message.pairKey === pair)
              .map((message) => message.id)
          : [];
      state.syncReceiptReads(
        requests,
        visible && onPanel && !state.historyVisible,
        displayed,
      );
    },
    { immediate: true },
  );

  return { pageVisible };
}
