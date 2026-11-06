import type { PanelStream } from '@/shared/api/raw-types';

/**
 * `/api/panel-agent/events` 的统一 reducer。
 *
 * 面板流的消费者有两个：PanelAgentPanel（私人会话正文/思考）与 HomeWorkbench
 * （主页进展摘要）。两者原先各自维护一份状态机与一份 EventSource；收口后由
 * `panel-stream-store` 建立唯一连接，本文件是唯一的状态迁移入口：新增流事件
 * 类型只改这里，消费者只读 `PanelStreamState`。
 */

export type PanelStreamEvent = {
  type:
    | 'snapshot'
    | 'start'
    | 'delta'
    | 'reasoning-delta'
    | 'phase'
    | 'complete'
    | 'cancelled'
    | 'error';
  stream?: PanelStream;
  streams?: PanelStream[];
  delta?: string;
};

export type SummaryStreamState = {
  stream: PanelStream | null;
  active: boolean;
};

export type PanelStreamState = {
  /** 私人会话正在流式输出的那一轮（PanelAgentPanel 消费）。 */
  private: PanelStream | null;
  /** 主页进展摘要那一轮（HomeWorkbench 消费）。 */
  summary: SummaryStreamState;
};

export function initialPanelStreamState(): PanelStreamState {
  return { private: null, summary: { stream: null, active: false } };
}

/** 私人会话流的正文/思考累积；终态由消费者在刷新后清理。 */
export function reducePrivatePanelStream(
  current: PanelStream | null,
  event: PanelStreamEvent,
): PanelStream | null {
  // 主页进展摘要也是 private 上下文的流，但它归 HomeWorkbench 的摘要状态消费，
  // 不写进私人会话正文，避免两个消费者共享连接后互相污染。
  const isConversation = (stream: PanelStream) =>
    stream.context === 'private' && stream.homeSummary !== true;
  if (event.type === 'snapshot') {
    return event.streams?.find(isConversation) ?? null;
  }
  const incoming = event.stream;
  if (!incoming || !isConversation(incoming)) return current;
  const sameTurn = current?.turnId === incoming.turnId;
  if (event.type === 'delta' && typeof event.delta === 'string') {
    return {
      ...incoming,
      text: (sameTurn ? (current?.text ?? '') : '') + event.delta,
      reasoning: sameTurn ? (current?.reasoning ?? '') : '',
      runPhase: 'writing',
    };
  }
  if (event.type === 'reasoning-delta' && typeof event.delta === 'string') {
    return {
      ...incoming,
      text: sameTurn ? (current?.text ?? '') : '',
      reasoning: (sameTurn ? (current?.reasoning ?? '') : '') + event.delta,
      runPhase: 'thinking',
    };
  }
  // 阶段事件只更新阶段与工具，已累积的正文和思考保持原值。
  if (event.type === 'phase') {
    return sameTurn
      ? {
          ...incoming,
          text: current?.text ?? '',
          reasoning: current?.reasoning ?? '',
        }
      : incoming;
  }
  if (event.type === 'complete') return incoming;
  if (event.type === 'cancelled' || event.type === 'error') return null;
  return incoming;
}

/** 主页进展摘要：snapshot 恢复、增量累积、终态结算（迁自 summary-stream.ts）。 */
export function reduceSummaryStream(
  state: SummaryStreamState,
  event: PanelStreamEvent,
): SummaryStreamState {
  const isSummary = (stream: PanelStream) =>
    stream.context === 'private' && stream.homeSummary === true;
  if (event.type === 'snapshot') {
    const stream = event.streams
      ?.filter(isSummary)
      .sort((a, b) => b.created.localeCompare(a.created))[0];
    return stream
      ? { stream, active: true }
      : state.active
        ? { stream: null, active: false }
        : state;
  }
  const incoming = event.stream;
  if (!incoming || !isSummary(incoming)) return state;
  if (
    state.stream &&
    incoming.turnId !== state.stream.turnId &&
    incoming.created < state.stream.created
  )
    return state;
  const previous =
    state.stream?.turnId === incoming.turnId ? state.stream : null;
  if (
    previous &&
    !state.active &&
    !['complete', 'error', 'cancelled'].includes(event.type)
  )
    return state;
  if (event.type === 'error' || event.type === 'cancelled')
    return { stream: null, active: false };
  if (event.type === 'delta')
    return {
      stream: {
        ...incoming,
        text: (previous?.text ?? '') + (event.delta ?? ''),
        reasoning: '',
      },
      active: true,
    };
  if (event.type === 'reasoning-delta')
    return {
      stream: {
        ...incoming,
        text: previous?.text ?? '',
        reasoning: '',
        runPhase: 'thinking',
      },
      active: true,
    };
  if (event.type === 'phase')
    return {
      stream: {
        ...incoming,
        text: incoming.text || previous?.text || '',
        reasoning: '',
      },
      active: true,
    };
  return {
    stream: { ...incoming, reasoning: '' },
    active: event.type !== 'complete',
  };
}

/** 两种消费者共享同一次连接与同一份事件流；状态未变化时保持原引用。 */
export function reducePanelStream(
  state: PanelStreamState,
  event: PanelStreamEvent,
): PanelStreamState {
  const privateStream = reducePrivatePanelStream(state.private, event);
  const summary = reduceSummaryStream(state.summary, event);
  if (privateStream === state.private && summary === state.summary) return state;
  return { private: privateStream, summary };
}
