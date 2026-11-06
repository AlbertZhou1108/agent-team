import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { openEventStream, useEventStream } from './use-event-stream';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  private listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (event: { data: string }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(payload: unknown) {
    for (const listener of this.listeners.get('panel-stream') ?? [])
      listener({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }
}

let frames: Array<() => void> = [];
let cancelled = 0;

beforeEach(() => {
  FakeEventSource.instances = [];
  frames = [];
  cancelled = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
    frames.push(() => run(0));
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    cancelled += 1;
  });
});

function flushFrame() {
  const pending = frames;
  frames = [];
  for (const run of pending) run();
}

describe('unified event stream', () => {
  it('batches token deltas into one render frame while applying state transitions immediately', () => {
    const seen: string[] = [];
    openEventStream<{ type: string; delta?: string }>({
      url: '/api/panel-agent/events',
      eventName: 'panel-stream',
      onEvent: (event) => seen.push(event.delta ?? event.type),
      flushImmediately: (event) =>
        event.type !== 'delta' && event.type !== 'reasoning-delta',
    });
    const source = FakeEventSource.instances[0]!;
    source.emit({ type: 'start' });
    expect(seen).toEqual(['start']);
    source.emit({ type: 'delta', delta: '甲' });
    source.emit({ type: 'delta', delta: '乙' });
    expect(seen).toEqual(['start']);
    flushFrame();
    // 同一帧内的增量按到达顺序合并应用一次。
    expect(seen).toEqual(['start', '甲', '乙']);
    source.emit({ type: 'complete' });
    expect(seen).toEqual(['start', '甲', '乙', 'complete']);
  });

  it('drops malformed events and stops delivering after close', () => {
    const seen: unknown[] = [];
    const handle = openEventStream({
      url: '/api/teams/g1/events',
      eventName: 'panel-stream',
      onEvent: (event) => seen.push(event),
    });
    const source = FakeEventSource.instances[0]!;
    source.emit('not json');
    source.emit({ type: 'start' });
    flushFrame();
    expect(seen).toEqual([{ type: 'start' }]);
    handle.close();
    expect(source.closed).toBe(true);
    source.emit({ type: 'start' });
    flushFrame();
    expect(seen).toEqual([{ type: 'start' }]);
  });

  it('useEventStream closes its connection when the owning scope is disposed', () => {
    const scope = effectScope();
    const handle = scope.run(() =>
      useEventStream({ url: '/api/panel-agent/events', eventName: 'panel-stream', onEvent: () => {} }),
    )!;
    expect(FakeEventSource.instances).toHaveLength(1);
    scope.stop();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    handle.close();
    expect(cancelled).toBe(0);
  });

  it('flushes pending frame events on demand before closing', () => {
    const seen: unknown[] = [];
    const handle = openEventStream({
      url: '/api/panel-agent/events',
      eventName: 'panel-stream',
      onEvent: (event) => seen.push(event),
    });
    FakeEventSource.instances[0]!.emit({ type: 'delta', delta: 'x' });
    expect(seen).toEqual([]);
    handle.flush();
    expect(seen).toEqual([{ type: 'delta', delta: 'x' }]);
    handle.close();
  });
});
