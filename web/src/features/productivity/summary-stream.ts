import type { PanelStream } from '@/shared/api/raw-types';
export type SummaryStreamState = {
  stream: PanelStream | null;
  active: boolean;
};
export type SummaryStreamEvent = {
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
export function reduceSummaryStream(
  state: SummaryStreamState,
  event: SummaryStreamEvent,
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
