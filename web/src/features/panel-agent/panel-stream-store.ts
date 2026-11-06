import { shallowRef } from 'vue';
import {
  openEventStream,
  type EventStreamHandle,
} from '@/features/streams/use-event-stream';
import {
  initialPanelStreamState,
  reducePanelStream,
  type PanelStreamEvent,
  type PanelStreamState,
} from '@/features/streams/panel-reducer';

/**
 * `/api/panel-agent/events` 的模块级单例连接。
 *
 * PanelAgentPanel 与 HomeWorkbench 同时（或先后）挂在页面上时只保留一条连接：
 * 两个消费者各 `retain()` 一次，最后一个释放时关闭连接并清空流状态。事件在
 * 这里按帧合并后先落统一 reducer，再同步分发给订阅者（订阅者只做刷新等副作用）。
 */

export type PanelStreamListener = (event: PanelStreamEvent) => void;

const state = shallowRef<PanelStreamState>(initialPanelStreamState());
const eventListeners = new Set<PanelStreamListener>();
const openListeners = new Set<() => void>();
let handle: EventStreamHandle | null = null;
let consumers = 0;
let connected = false;

function connect() {
  connected = false;
  handle = openEventStream<PanelStreamEvent>({
    url: '/api/panel-agent/events',
    eventName: 'panel-stream',
    // 宿主以 token 级频率推送增量（实测思考 ~108/s、正文 ~230/s）；按渲染帧合并，
    // 状态转换（非增量）立即应用，避免顺序与终态被延迟。
    flushImmediately: (event) =>
      event.type !== 'delta' && event.type !== 'reasoning-delta',
    onEvent(event) {
      state.value = reducePanelStream(state.value, event);
      for (const listener of [...eventListeners]) listener(event);
    },
    onOpen() {
      connected = true;
      for (const listener of [...openListeners]) listener();
    },
  });
}

function disconnect() {
  handle?.close();
  handle = null;
  connected = false;
  const current = state.value;
  if (
    current.private !== null ||
    current.summary.stream !== null ||
    current.summary.active
  ) {
    state.value = initialPanelStreamState();
  }
}

export function usePanelStream() {
  return {
    /** 统一 reducer 后的流状态；只在事件/清理时整体替换引用。 */
    state,
    /** 持有连接；返回幂等释放函数。最后一个消费者释放时连接关闭。 */
    retain(): () => void {
      consumers += 1;
      if (!handle) connect();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        consumers = Math.max(0, consumers - 1);
        if (consumers === 0) disconnect();
      };
    },
    /** 订阅已按帧合并的事件（副作用属于组件，状态属于本模块）。 */
    subscribe(listener: PanelStreamListener): () => void {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    /** 连接建立/自动重连后回调；连接已建立时立即触发一次。 */
    subscribeOpen(listener: () => void): () => void {
      openListeners.add(listener);
      if (connected) listener();
      return () => openListeners.delete(listener);
    },
    /** 完成态在消费者刷新到持久化消息后清理。 */
    clearPrivate() {
      if (state.value.private === null) return;
      state.value = { ...state.value, private: null };
    },
    resetSummary() {
      const { summary } = state.value;
      if (summary.stream === null && !summary.active) return;
      state.value = {
        ...state.value,
        summary: { stream: null, active: false },
      };
    },
  };
}

export type PanelStreamStore = ReturnType<typeof usePanelStream>;
