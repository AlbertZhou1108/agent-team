// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import TelemetryCoordinationWorkspace from '@/features/telemetry/TelemetryCoordinationWorkspace.vue';
import type {
  TelemetryCoordinationResponse,
  TelemetryMetric,
  TelemetryMetrics,
  TelemetryMembersResponse,
} from '@/shared/api/raw-types';

const metric = (value: number | null): TelemetryMetric => ({
  value,
  quality: 'measured',
  completeness: 'complete',
  scope: 'session',
  aggregation: 'sum',
  source: 'test',
  missingReason: value == null ? 'not_captured' : null,
  observedAt: '2026-11-22T14:48:02Z',
});

const metrics = (total: number): TelemetryMetrics => ({
  inputTokensTotal: metric(Math.round(total * 0.9)),
  uncachedInputTokens: metric(Math.round(total * 0.2)),
  cacheReadTokens: metric(Math.round(total * 0.6)),
  cacheWriteTokens: metric(Math.round(total * 0.1)),
  outputTokens: metric(Math.round(total * 0.1)),
  totalTokens: metric(total),
  cacheReadRatio: { ...metric(0.6667), aggregation: 'ratio' },
  executionWallMs: metric(12400),
  hostTurnWallMs: metric(10200),
});

const coordContextRef = {
  lastRequestInputTokens: metric(63000),
  contextWindowTokens: metric(200000),
  lastRequestInputRatio: { ...metric(0.315), aggregation: 'ratio' as const },
  sampledAt: '2026-11-22T14:48:02Z',
  sampleTurnId: 'turn_1',
  model: {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    source: 'test',
    observedAt: '2026-11-22T14:48:02Z',
  },
};

const coordResponse: TelemetryCoordinationResponse = {
  schemaVersion: 1,
  readOnly: true,
  groupId: 'g1',
  generatedAt: '2026-11-22T14:48:02Z',
  range: { from: null, to: null },
  coordination: {
    executor: { kind: 'member', memberId: 'm1', name: '主 Agent', host: 'claude' },
    physicalSessions: [
      {
        instanceId: 'inst_coord_1',
        host: 'claude',
        endpointId: 'ep_coord',
        memberId: 'm1',
        context: 'coordination',
        peer: null,
        sessionKey: 'coord:main',
        hostSessionNamespace: 'claude',
        hostSessionId: 'ses_coord_1',
        firstObservedAt: '2026-11-22T14:00:00Z',
        resetAt: null,
        status: 'active',
        consumption: metrics(400000),
        contextReference: coordContextRef,
        coverage: {
          captureStartedAt: null,
          complete: false,
          reasons: ['partial_capture'],
          batchCount: 11,
          completeBatchCount: 10,
          partialBatchCount: 1,
          unknownBatchCount: 0,
        },
      },
    ],
  },
  batches: [],
  nextCursor: null,
  summary: {
    executorTotals: metrics(400000),
    contextReference: coordContextRef,
    singleSourceBatchIds: [],
    mergedBatchIds: [],
    sharedSourceBatchIds: [],
    sourceSubtotals: [],
    coverage: {
      captureStartedAt: null,
      complete: false,
      reasons: ['partial_capture'],
      batchCount: 11,
      completeBatchCount: 10,
      partialBatchCount: 1,
      unknownBatchCount: 0,
    },
  },
  provenance: [],
};

const membersResponse: TelemetryMembersResponse = {
  schemaVersion: 1,
  readOnly: true,
  groupId: 'g1',
  generatedAt: '2026-11-22T14:48:02Z',
  range: { from: null, to: null },
  members: [
    {
      executor: { kind: 'member', memberId: 'm1', name: '主 Agent', host: 'claude' },
      physicalSessions: [
        {
          instanceId: 'inst_m1',
          host: 'claude',
          endpointId: 'ep_m1',
          memberId: 'm1',
          context: 'coordination',
          peer: null,
          sessionKey: 'coord:main',
          hostSessionNamespace: 'claude',
          hostSessionId: 'ses_m1',
          firstObservedAt: '2026-11-22T14:00:00Z',
          resetAt: null,
          status: 'active',
          consumption: metrics(400000),
          contextReference: coordResponse.summary.contextReference,
          coverage: coordResponse.summary.coverage,
        },
      ],
      physicalSessionCount: 1,
      batchCount: 11,
      totals: metrics(400000),
      contextReference: coordResponse.summary.contextReference,
      coverage: coordResponse.summary.coverage,
    },
    {
      executor: { kind: 'member', memberId: 'm2', name: '后端实现', host: 'codex' },
      physicalSessions: [
        {
          instanceId: 'inst_m2',
          host: 'codex',
          endpointId: 'ep_m2',
          memberId: 'm2',
          context: 'pair',
          peer: 'm1',
          sessionKey: 'member:m2',
          hostSessionNamespace: 'codex',
          hostSessionId: 'thread_m2',
          firstObservedAt: '2026-11-22T14:10:00Z',
          resetAt: null,
          status: 'ended',
          consumption: metrics(180000),
          contextReference: {
            lastRequestInputTokens: metric(32000),
            contextWindowTokens: metric(128000),
            lastRequestInputRatio: { ...metric(0.25), aggregation: 'ratio' },
            sampledAt: '2026-11-22T14:48:02Z',
            sampleTurnId: 'turn_2',
            model: { provider: 'openai', model: 'gpt-5.4', source: 'test', observedAt: '2026-11-22T14:48:02Z' },
          },
          coverage: {
            ...coordResponse.summary.coverage,
            complete: false,
            batchCount: 6,
          },
        },
      ],
      physicalSessionCount: 1,
      batchCount: 6,
      totals: metrics(180000),
      contextReference: {
        lastRequestInputTokens: metric(32000),
        contextWindowTokens: metric(128000),
        lastRequestInputRatio: { ...metric(0.25), aggregation: 'ratio' },
        sampledAt: '2026-11-22T14:48:02Z',
        sampleTurnId: 'turn_2',
        model: { provider: 'openai', model: 'gpt-5.4', source: 'test', observedAt: '2026-11-22T14:48:02Z' },
      },
      coverage: {
        ...coordResponse.summary.coverage,
        complete: false,
        batchCount: 6,
      },
    },
  ],
  sourceAnalysis: {
    note: '',
    actors: [
      {
        sourceActorId: 'm1',
        sourceActorName: '主 Agent',
        totals: metrics(250000),
        includedBatchIds: ['b1', 'b2'],
        excludedMergedBatchIds: [],
      },
    ],
    mergedBatchIds: [],
    sharedSourceBatchIds: [],
  },
  provenance: [],
};

vi.mock('@/features/queries', () => ({
  useCoordinationTelemetryQuery: () => ({
    data: ref(coordResponse),
    isPending: ref(false),
    error: ref(null),
  }),
  useMembersTelemetryQuery: () => ({
    data: ref(membersResponse),
    isPending: ref(false),
    error: ref(null),
  }),
}));

describe('TelemetryCoordinationWorkspace', () => {
  it('渲染宽版总览、右下角展开/收起、左右成员主从且不显示采集完整度徽章', async () => {
    const wrapper = mount(TelemetryCoordinationWorkspace, {
      props: { groupId: 'g1' },
    });

    const text = wrapper.text();
    expect(text).toContain('协调会话总用量（主 Agent 统一调度）');
    expect(text).toContain('11 个协调回合 · 1 个物理 session');
    expect(text).toContain('成员开销排行（2）');
    expect(text).not.toContain('点击查看执行详情');
    expect(text).not.toContain('部分采集');
    expect(text).not.toContain('完整采集');

    // 默认收起（CollapseReveal 常驻 DOM，以 data-open/inert 驱动 grid-rows 双向动画），点击右下角展开按钮展开。
    const reveal = wrapper.get('[data-testid="coord-all-metrics-reveal"]');
    expect(reveal.attributes('data-open')).toBe('false');
    expect(reveal.attributes('inert')).toBeDefined();
    const toggleBtn = wrapper.get('[data-testid="coord-toggle-all"]');
    expect(toggleBtn.text()).toContain('展开');
    expect(toggleBtn.attributes('aria-controls')).toBe(reveal.attributes('id'));
    await toggleBtn.trigger('click');
    await nextTick();
    expect(reveal.attributes('data-open')).toBe('true');
    expect(reveal.attributes('inert')).toBeUndefined();
    expect(toggleBtn.text()).toContain('收起');
    await toggleBtn.trigger('click');
    await nextTick();
    expect(reveal.attributes('data-open')).toBe('false');
    expect(toggleBtn.text()).toContain('展开');

    // 默认选中榜首「主 Agent」，右侧直接平铺 9 项指标与物理 session。
    const detail = wrapper.get('[data-testid="telemetry-member-detail"]');
    expect(detail.text()).toContain('主 Agent · 执行详情');
    expect(detail.findAll('[data-metric-key]')).toHaveLength(9);
    expect(detail.text()).toContain('inst_m1');

    // 点击左侧「后端实现」切换右侧详情。
    await wrapper.get('[data-member-rank-id="m2"]').trigger('click');
    await nextTick();
    expect(detail.text()).toContain('后端实现 · 执行详情');
    expect(detail.text()).toContain('inst_m2');
  });

  it('支持通过 selectedMemberId 初始定位到指定成员', () => {
    const wrapper = mount(TelemetryCoordinationWorkspace, {
      props: { groupId: 'g1', selectedMemberId: 'm2' },
    });
    expect(wrapper.get('[data-testid="telemetry-member-detail"]').text()).toContain('后端实现 · 执行详情');
  });
});
