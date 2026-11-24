<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Gauge, Users } from '@lucide/vue';
import { MetricCard, SectionBlock } from '@/components/panel';
import PanelState from '@/components/panel/PanelState.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { DisclosureFooter } from '@/components/ui/disclosure';
import { Progress } from '@/components/ui/progress';
import {
  useCoordinationTelemetryQuery,
  useMembersTelemetryQuery,
} from '@/features/queries';
import type {
  TelemetryContextReference,
  TelemetryMetrics,
} from '@/shared/api/raw-types';
import { hostDisplayLabel } from '@/shared/models/host-labels';
import TelemetrySourceSubtotals from './TelemetrySourceSubtotals.vue';
import {
  CONTEXT_METRIC_LABELS,
  METRIC_KEYS,
  METRIC_LABELS,
  contextMetricDisplay,
  formatTimestamp,
  metricDisplay,
  missingReasonLabel,
  sessionStatusLabel,
} from './format';
import {
  compactDuration,
  compactNumber,
  numeric,
  ratioPercent,
  relativeValues,
} from './visuals';

/**
 * 团队主区「协调遥测」工作区（挂载于 team-tabs 槽位）。
 * 上层展示主 Agent 统一调度总用量概览，下层以左右主从双栏呈现成员消耗排行、
 * 来源分析及选中成员的完整 9 项指标与物理 session 累计。
 */
const props = defineProps<{
  groupId?: string;
  selectedMemberId?: string;
}>();

const coordinationQuery = useCoordinationTelemetryQuery(
  () => props.groupId || undefined,
  () => Boolean(props.groupId),
);
const membersQuery = useMembersTelemetryQuery(() => props.groupId || undefined);

const coordMetricsOpen = ref(false);
const selectedId = ref(props.selectedMemberId ?? '');

watch(
  () => props.groupId,
  () => {
    selectedId.value = props.selectedMemberId ?? '';
    coordMetricsOpen.value = false;
  },
);
watch(
  () => props.selectedMemberId,
  (next) => {
    if (next) selectedId.value = next;
  },
);

const coordData = computed(() => coordinationQuery.data.value);
const coordTotals = computed<TelemetryMetrics | null>(
  () => coordData.value?.summary.executorTotals ?? null,
);
const coordContext = computed<TelemetryContextReference | null>(
  () => coordData.value?.summary.contextReference ?? null,
);
const coordBatchCount = computed(
  () => coordData.value?.summary.coverage.batchCount ?? 0,
);
const coordSessionCount = computed(
  () => coordData.value?.coordination?.physicalSessions.length ?? 0,
);
const coordCachePercent = computed(() =>
  coordTotals.value ? ratioPercent(coordTotals.value.cacheReadRatio) : null,
);
const coordContextPercent = computed(() =>
  coordContext.value ? ratioPercent(coordContext.value.lastRequestInputRatio) : null,
);

const coordSegments = computed(() => {
  const metrics = coordTotals.value;
  if (!metrics) return [];
  const items = [
    {
      key: 'cacheReadTokens',
      label: '缓存读取',
      value: numeric(metrics.cacheReadTokens),
      color: 'var(--primary)',
    },
    {
      key: 'uncachedInputTokens',
      label: '未缓存输入',
      value: numeric(metrics.uncachedInputTokens),
      color: 'var(--warning)',
    },
    {
      key: 'cacheWriteTokens',
      label: '缓存写入',
      value: numeric(metrics.cacheWriteTokens),
      color: 'var(--info)',
    },
    {
      key: 'outputTokens',
      label: '输出',
      value: numeric(metrics.outputTokens),
      color: 'var(--success)',
    },
  ];
  const sum = items.reduce((acc, item) => acc + (item.value ?? 0), 0);
  if (sum <= 0) return [];
  return items.map((item) => ({
    ...item,
    percent: ((item.value ?? 0) / sum) * 100,
  }));
});

const coordErrorMessage = computed(() => {
  const raw = coordinationQuery.error.value?.message;
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    return parsed.error ?? raw;
  } catch {
    return raw;
  }
});

const membersData = computed(() => membersQuery.data.value);
const rankedMembers = computed(() => {
  const list = membersData.value?.members ?? [];
  const byId = new Map(list.map((item) => [item.executor.memberId, item]));
  return relativeValues(
    list.map((item) => ({
      id: item.executor.memberId,
      metric: item.totals.totalTokens,
    })),
  ).map((row) => ({
    ...row,
    entry: byId.get(row.id)!,
  }));
});

const selectedMember = computed(() => {
  const list = membersData.value?.members ?? [];
  if (!list.length) return undefined;
  return (
    list.find((item) => item.executor.memberId === selectedId.value) ??
    rankedMembers.value[0]?.entry
  );
});

function selectMember(id: string) {
  selectedId.value = id;
}

function modelLabel(refData?: TelemetryContextReference | null): string {
  const model = refData?.model;
  if (!model) return '默认模型';
  return model.provider ? `${model.provider}/${model.model}` : model.model;
}

function metricTitle(metrics: TelemetryMetrics, key: keyof TelemetryMetrics): string {
  const metric = metrics[key];
  if (metric?.value != null) return metricDisplay(metric, key);
  return metric?.missingReason ? missingReasonLabel(metric.missingReason) : '—';
}

function executorRoleLabel(kind: 'member' | 'panel_agent'): string {
  return kind === 'panel_agent' ? 'Panel Agent' : '成员';
}
</script>

<template>
  <div
    v-if="groupId"
    class="@container scrollbar-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-2 pb-4"
    data-testid="telemetry-coordination-workspace"
  >
    <!-- 第一层：协调会话总用量概览带 -->
    <SectionBlock
      title="协调会话总用量（主 Agent 统一调度）"
      :meta="`${coordBatchCount} 个协调回合 · ${coordSessionCount} 个物理 session · 更新 ${formatTimestamp(coordData?.generatedAt ?? null)}`"
      :container="false"
    >
      <PanelState v-if="coordinationQuery.isPending.value" loading title="正在读取协调遥测" />
      <Alert v-else-if="coordinationQuery.error.value" variant="destructive">
        <AlertDescription>读取协调遥测失败：{{ coordErrorMessage }}</AlertDescription>
      </Alert>
      <PanelState
        v-else-if="!coordTotals"
        :icon="Gauge"
        title="暂无协调遥测"
        description="主 Agent 统一调度执行并上报指标后显示。"
      />
      <template v-else>
        <!-- 4 列核心 KPI -->
        <div class="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
          <MetricCard
            label="协调总 Token"
            :value="compactNumber(numeric(coordTotals.totalTokens))"
            :value-title="metricDisplay(coordTotals.totalTokens, 'totalTokens')"
            :subtitle="`输入 ${compactNumber(numeric(coordTotals.inputTokensTotal))} · 输出 ${compactNumber(numeric(coordTotals.outputTokens))}`"
          />

          <MetricCard
            label="缓存读取占比"
            :value="metricDisplay(coordTotals.cacheReadRatio, 'cacheReadRatio')"
            :progress="coordCachePercent ?? 0"
            :progress-label="`缓存读取占比 ${metricDisplay(coordTotals.cacheReadRatio, 'cacheReadRatio')}`"
            :subtitle="`缓存读 ${compactNumber(numeric(coordTotals.cacheReadTokens))} / 输入 ${compactNumber(numeric(coordTotals.inputTokensTotal))}`"
          />

          <MetricCard
            label="框架执行耗时"
            :value="compactDuration(numeric(coordTotals.executionWallMs))"
            :subtitle="`宿主回合耗时 ${compactDuration(numeric(coordTotals.hostTurnWallMs))}`"
          />

          <MetricCard
            label="主控上下文水位"
            :value="coordContext
              ? contextMetricDisplay(coordContext.lastRequestInputRatio, 'lastRequestInputRatio')
              : '—'"
            :progress="coordContextPercent ?? 0"
            progress-label="主控上下文水位"
            :subtitle="`最近输入 ${compactNumber(numeric(coordContext?.lastRequestInputTokens))} / 容量 ${compactNumber(numeric(coordContext?.contextWindowTokens))}`"
          />
        </div>

        <!-- 构成比例条 + 可展开 9 项指标 + 底部右下角展开/收起按钮 -->
        <div class="flex flex-col pt-0.5">
          <div
            v-if="coordSegments.length"
            class="mb-2 flex h-2 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label="协调会话 Token 构成"
          >
            <div
              v-for="seg in coordSegments"
              :key="seg.key"
              :style="{ width: `${seg.percent}%`, background: seg.color }"
              :title="`${seg.label}：${compactNumber(seg.value)}`"
            />
          </div>

          <DisclosureFooter
            v-model:open="coordMetricsOpen"
            reveal-test-id="coord-all-metrics-reveal"
            toggle-test-id="coord-toggle-all"
          >
            <div data-testid="coord-all-metrics">
              <dl class="grid grid-cols-2 gap-x-6 gap-y-1.5 border-t border-border pt-2 text-xs tabular-nums @xl:grid-cols-3">
                <div
                  v-for="key in METRIC_KEYS"
                  :key="key"
                  class="flex items-center justify-between gap-2 border-b border-border/50 py-1"
                >
                  <dt class="text-muted-foreground">{{ METRIC_LABELS[key] }}</dt>
                  <dd class="font-medium text-foreground" :title="metricTitle(coordTotals, key)">
                    {{ metricDisplay(coordTotals[key], key) }}
                  </dd>
                </div>
              </dl>
            </div>
            <template #footer-start>
              <div v-if="coordSegments.length" class="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span
                  v-for="seg in coordSegments"
                  :key="seg.key"
                  class="inline-flex items-center gap-1.5"
                >
                  <span class="size-2 rounded-full" :style="{ background: seg.color }" />
                  {{ seg.label }} {{ compactNumber(seg.value) }} ({{ seg.percent.toFixed(1) }}%)
                </span>
              </div>
            </template>
          </DisclosureFooter>
        </div>
      </template>
    </SectionBlock>

    <!-- 第二层：左右双栏主从区 -->
    <div class="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-12">
      <!-- 左栏 5 列：成员开销排行 + 来源分析 -->
      <div class="flex min-w-0 flex-col gap-3 @4xl:col-span-5">
        <SectionBlock
          :heading-level="3"
          :title="`成员开销排行（${rankedMembers.length}）`"
          :container="false"
          class="gap-2.5"
        >

          <PanelState v-if="membersQuery.isPending.value" loading title="正在读取成员遥测" />
          <Alert v-else-if="membersQuery.error.value" variant="destructive">
            <AlertDescription>读取成员遥测失败：{{ membersQuery.error.value.message }}</AlertDescription>
          </Alert>
          <PanelState v-else-if="!rankedMembers.length" :icon="Users" title="暂无成员遥测" />
          <div v-else class="flex flex-col gap-1.5" data-testid="telemetry-member-ranking">
            <button
              v-for="row in rankedMembers"
              :key="row.id"
              type="button"
              class="flex w-full min-w-0 flex-col gap-1.5 rounded-(--component-control-radius) border p-2.5 text-left transition-colors"
              :class="row.id === selectedMember?.executor.memberId
                ? 'border-primary bg-accent/60'
                : 'border-border bg-card/60 hover:bg-accent/30'"
              :aria-pressed="row.id === selectedMember?.executor.memberId"
              :data-member-rank-id="row.id"
              @click="selectMember(row.id)"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate text-xs font-semibold text-foreground">{{
                    row.entry.executor.name
                  }}</span>
                  <Badge variant="secondary" size="xs" class="shrink-0">
                    {{ hostDisplayLabel(row.entry.executor.host) }}
                  </Badge>
                </div>
                <span class="shrink-0 text-xs font-semibold tabular-nums">{{
                  compactNumber(row.value)
                }}</span>
              </div>
              <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  class="h-full bg-primary"
                  :style="{ width: `${row.percent ?? 0}%` }"
                />
              </div>
              <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
                <span class="min-w-0 truncate">{{ modelLabel(row.entry.contextReference) }}</span>
                <span class="shrink-0">
                  {{ row.entry.batchCount }} 回合 · 缓存
                  {{ metricDisplay(row.entry.totals.cacheReadRatio, 'cacheReadRatio') }}
                </span>
              </div>
            </button>
          </div>
        </SectionBlock>

        <SectionBlock v-if="membersData" :container="false">
          <TelemetrySourceSubtotals
            :subtotals="membersData.sourceAnalysis.actors"
            :merged-batch-ids="membersData.sourceAnalysis.mergedBatchIds"
            :shared-source-batch-ids="membersData.sourceAnalysis.sharedSourceBatchIds"
            :note="membersData.sourceAnalysis.note"
          />
        </SectionBlock>
      </div>

      <!-- 右栏 7 列：选中成员执行详情 -->
      <SectionBlock
        :container="false"
        size="lg"
        class="@4xl:col-span-7"
        data-testid="telemetry-member-detail"
      >
        <PanelState
          v-if="!selectedMember"
          :icon="Users"
          title="暂无成员详情"
          description="选择左侧成员查看详细遥测。"
        />
        <template v-else>
          <header class="flex flex-col gap-1 border-b border-border pb-3">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-sm font-semibold">
                {{ selectedMember.executor.name }} · 执行详情
              </h3>
              <Badge variant="outline">{{
                hostDisplayLabel(selectedMember.executor.host)
              }}</Badge>
              <Badge variant="secondary">{{
                executorRoleLabel(selectedMember.executor.kind)
              }}</Badge>
            </div>
            <p class="text-xs text-muted-foreground tabular-nums">
              模型 {{ modelLabel(selectedMember.contextReference) }} ·
              {{ selectedMember.batchCount }} 个回合 ·
              {{ selectedMember.physicalSessions.length }} 个物理 session · 按执行归属汇总
            </p>
          </header>

          <!-- 区块 A：上下文参考 -->
          <div class="flex flex-col gap-2 rounded-(--component-control-radius) border border-border bg-card/60 p-3">
            <div class="flex items-center justify-between text-xs">
              <span class="font-semibold">上下文参考（最近一次请求）</span>
              <span class="text-muted-foreground tabular-nums">
                占比
                {{
                  contextMetricDisplay(
                    selectedMember.contextReference.lastRequestInputRatio,
                    'lastRequestInputRatio',
                  )
                }}
              </span>
            </div>
            <Progress
              :model-value="ratioPercent(selectedMember.contextReference.lastRequestInputRatio) ?? 0"
              aria-label="选中成员上下文占用"
              class="h-1.5"
            />
            <dl class="grid grid-cols-3 gap-2 pt-1 text-xs tabular-nums">
              <div
                v-for="ctxKey in (['lastRequestInputTokens', 'contextWindowTokens', 'lastRequestInputRatio'] as const)"
                :key="ctxKey"
              >
                <dt class="text-muted-foreground">{{ CONTEXT_METRIC_LABELS[ctxKey] }}</dt>
                <dd class="mt-0.5 font-medium text-foreground">
                  {{
                    contextMetricDisplay(selectedMember.contextReference[ctxKey], ctxKey)
                  }}
                </dd>
              </div>
            </dl>
          </div>

          <!-- 区块 B：全部 9 项遥测指标（直接平铺） -->
          <div class="flex flex-col gap-2">
            <h4 class="text-xs font-semibold text-muted-foreground">全部遥测指标（9 项）</h4>
            <div class="grid grid-cols-2 gap-2.5 @md:grid-cols-3">
              <MetricCard
                v-for="key in METRIC_KEYS"
                :key="key"
                size="sm"
                :label="METRIC_LABELS[key]"
                :value="metricDisplay(selectedMember.totals[key], key)"
                :value-title="metricTitle(selectedMember.totals, key)"
                :data-metric-key="key"
              />
            </div>
          </div>

          <!-- 区块 C：物理 Session 累计 -->
          <div class="flex flex-col gap-2 pt-0.5">
            <h4 class="text-xs font-semibold text-muted-foreground">
              物理 session 累计（{{ selectedMember.physicalSessions.length }}）
            </h4>
            <p v-if="!selectedMember.physicalSessions.length" class="text-xs text-muted-foreground">
              暂无物理 session 观测。
            </p>
            <div
              v-else
              class="divide-y divide-border rounded-(--component-control-radius) border border-border bg-card/60"
            >
              <div
                v-for="session in selectedMember.physicalSessions"
                :key="session.instanceId"
                class="flex flex-col gap-1 p-2.5 text-xs"
                :data-session-id="session.instanceId"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{{ hostDisplayLabel(session.host) }}</Badge>
                  <Badge variant="secondary">{{ sessionStatusLabel(session.status) }}</Badge>
                  <span class="min-w-0 truncate font-mono font-medium">{{
                    session.instanceId
                  }}</span>
                  <span class="ms-auto shrink-0 text-muted-foreground tabular-nums">
                    首次观测 {{ formatTimestamp(session.firstObservedAt) }}
                  </span>
                </div>
                <p class="truncate font-mono text-muted-foreground">
                  sessionKey {{ session.sessionKey }} · endpoint {{ session.endpointId }} ·
                  hostSessionId {{ session.hostSessionId ?? '未提供' }}
                </p>
              </div>
            </div>
          </div>
        </template>
      </SectionBlock>
    </div>
  </div>
</template>
