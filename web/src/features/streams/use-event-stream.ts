import { onScopeDispose } from 'vue';
import { frameBatch } from './frame-batch';

export type EventStreamHandle = {
  /** 立即应用已排队的增量（卸载/切换前调用，避免丢事件）。 */
  flush(): void;
  /** 取消排队帧并关闭连接；可重复调用。 */
  close(): void;
};

export type EventStreamOptions<T> = {
  url: string;
  /** 服务端 SSE 事件名，例如 `team-stream` / `panel-stream`。 */
  eventName: string;
  onEvent: (event: T) => void;
  /** 默认 `JSON.parse`；解析失败的事件被丢弃，下一次轮询或事件仍是权威。 */
  parse?: (data: string) => T;
  /** 连接建立（含 EventSource 自动重连）时回调，用于刷新对账。 */
  onOpen?: () => void;
  /** 默认按渲染帧合并增量并保序；false 时逐事件同步处理。 */
  batch?: boolean;
  /** 返回 true 的事件立即应用：状态转换不能等到下一帧。 */
  flushImmediately?: (event: T) => boolean;
  schedule?: (run: () => void) => number;
  cancel?: (id: number) => void;
};

/**
 * 统一 SSE 连接层：整个前端只在这里构造 EventSource。
 * - 只负责连接/解析/批帧/关闭，不持有业务状态；
 * - `onEvent` 收到的是已按帧合并、保序的事件；
 * - 关闭后不再回调，调用方无需自行判断。
 */
export function openEventStream<T>(options: EventStreamOptions<T>): EventStreamHandle {
  const parse = options.parse ?? ((data: string) => JSON.parse(data) as T);
  const batching = options.batch !== false;
  const batch = batching
    ? frameBatch<T>(
        options.onEvent,
        options.schedule ?? (run => requestAnimationFrame(run)),
        options.cancel ?? (id => cancelAnimationFrame(id)),
      )
    : null;
  const source = new EventSource(options.url);
  let closed = false;

  function handleMessage(event: Event) {
    if (closed) return;
    let payload: T;
    try {
      payload = parse((event as MessageEvent<string>).data);
    } catch {
      // 畸形事件忽略；下一次增量或状态轮询仍是权威。
      return;
    }
    if (!batch) {
      options.onEvent(payload);
      return;
    }
    batch.push(payload);
    if (options.flushImmediately?.(payload)) batch.flush();
  }

  source.addEventListener(options.eventName, handleMessage);
  if (options.onOpen) source.onopen = () => options.onOpen?.();

  return {
    flush() {
      batch?.flush();
    },
    close() {
      if (closed) return;
      closed = true;
      batch?.dispose();
      source.close();
    },
  };
}

/**
 * 组件作用域内的单条流：setup 时连接，作用域销毁时关闭。
 * 需要按路由参数重连（团队流）或模块级单例（panel 流）时直接用 `openEventStream`。
 */
export function useEventStream<T>(options: EventStreamOptions<T>): EventStreamHandle {
  const handle = openEventStream(options);
  onScopeDispose(() => handle.close());
  return handle;
}
