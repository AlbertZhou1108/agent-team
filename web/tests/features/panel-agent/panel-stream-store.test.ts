import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelStream } from '@/shared/api/raw-types';

/**
 * `/api/panel-agent/events` 单例连接测试：用假 EventSource 断言
 * PanelAgentPanel 与 HomeWorkbench 共享的唯一连接、事件流经统一 reducer，
 * 以及最后一个消费者释放后关闭连接并清空流状态。
 */

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
  emit(name: string, payload: unknown) {
    for (const listener of this.listeners.get(name) ?? [])
      listener({ data: JSON.stringify(payload) });
  }
}

const stream: PanelStream = {
  agentId: 'panel',
  sessionId: 'private',
  turnId: 'chat',
  context: 'private',
  activeTeamId: null,
  text: '',
  created: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};

let frames: Array<() => void> = [];

beforeEach(() => {
  vi.resetModules();
  FakeEventSource.instances = [];
  frames = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
    frames.push(() => run(0));
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

async function store() {
  return (await import('@/features/panel-agent/panel-stream-store')).usePanelStream();
}

function flushFrame() {
  const pending = frames;
  frames = [];
  for (const run of pending) run();
}

describe('panel stream singleton', () => {
  it('opens exactly one EventSource for every consumer and closes it after the last release', async () => {
    const panelStream = await store();
    const releasePanel = panelStream.retain();
    const releaseWorkbench = panelStream.retain();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/panel-agent/events');
    releasePanel();
    expect(FakeEventSource.instances[0]!.closed).toBe(false);
    releaseWorkbench();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    // 释放后再消费会重新建立连接，但同一时刻仍只有一条。
    const releaseAgain = panelStream.retain();
    expect(FakeEventSource.instances).toHaveLength(2);
    releaseAgain();
  });

  it('feeds both consumers from the unified reducer and notifies subscribers per event', async () => {
    const panelStream = await store();
    const release = panelStream.retain();
    const events: string[] = [];
    const stop = panelStream.subscribe((event) => events.push(event.type));
    const source = FakeEventSource.instances[0]!;
    source.emit('panel-stream', {
      type: 'snapshot',
      streams: [
        { ...stream, text: '在飞' },
        {
          ...stream,
          turnId: 'summary',
          homeSummary: true,
          text: '摘要',
        },
      ],
    });
    // snapshot 是状态转换，立即应用，不等渲染帧。
    expect(panelStream.state.value.private?.text).toBe('在飞');
    expect(panelStream.state.value.summary.stream?.text).toBe('摘要');
    source.emit('panel-stream', { type: 'delta', stream, delta: '继续' });
    // 增量按帧合并：帧前未落状态，帧后只应用一次。
    expect(panelStream.state.value.private?.text).toBe('在飞');
    flushFrame();
    expect(panelStream.state.value.private?.text).toBe('在飞继续');
    expect(events).toEqual(['snapshot', 'delta']);
    stop();
    release();
  });

  it('clears private/summary projections on demand and on last release', async () => {
    let panelStream = await store();
    let release = panelStream.retain();
    FakeEventSource.instances[0]!.emit('panel-stream', {
      type: 'snapshot',
      streams: [
        { ...stream, text: '会话' },
        { ...stream, turnId: 'summary', homeSummary: true, text: '摘要' },
      ],
    });
    panelStream.clearPrivate();
    expect(panelStream.state.value.private).toBeNull();
    expect(panelStream.state.value.summary.stream?.text).toBe('摘要');
    panelStream.resetSummary();
    expect(panelStream.state.value.summary).toEqual({
      stream: null,
      active: false,
    });
    FakeEventSource.instances[0]!.emit('panel-stream', {
      type: 'snapshot',
      streams: [{ ...stream, text: '会话' }],
    });
    release();
    expect(panelStream.state.value.private).toBeNull();
    // 释放后重新 retain 会拿到全新连接与干净状态。
    panelStream = await store();
    release = panelStream.retain();
    expect(panelStream.state.value.private).toBeNull();
    release();
  });

  it('notifies open subscribers on connect (and immediately when already connected)', async () => {
    const panelStream = await store();
    const release = panelStream.retain();
    const opened = vi.fn();
    const stop = panelStream.subscribeOpen(opened);
    expect(opened).not.toHaveBeenCalled();
    FakeEventSource.instances[0]!.onopen?.();
    expect(opened).toHaveBeenCalledTimes(1);
    // 已连接时新增订阅者立即回调一次（各消费者各自的 onopen 对账语义）。
    const late = vi.fn();
    const stopLate = panelStream.subscribeOpen(late);
    expect(late).toHaveBeenCalledTimes(1);
    stop();
    stopLate();
    release();
  });
});
