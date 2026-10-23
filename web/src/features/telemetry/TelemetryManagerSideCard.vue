<script setup lang="ts">
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import type {
  TelemetryContextReference,
  TelemetryCoverage,
  TelemetryExecutor,
  TelemetryMetrics,
  TelemetrySessionTelemetry,
} from '@/shared/api/raw-types';
import TelemetryMetricGrid from './TelemetryMetricGrid.vue';
import TelemetryContextCard from './TelemetryContextCard.vue';
import TelemetryCoveragePanel from './TelemetryCoverage.vue';
import {
  formatTimestamp,
  metricDisplay,
  sessionStatusLabel,
} from './format';

withDefaults(
  defineProps<{
    side: 'member' | 'manager';
    title: string;
    executor: TelemetryExecutor;
    totals: TelemetryMetrics;
    contextReference: TelemetryContextReference;
    coverage: TelemetryCoverage;
    batchCount: number;
    physicalSessions: TelemetrySessionTelemetry[];
    badges?: string[];
    note?: string;
  }>(),
  { badges: () => [], note: '' },
);
</script>

<template>
  <Card
    class="min-w-0 gap-4 py-4"
    :data-manager-side="side"
    :data-manager-side-executor="executor.memberId"
  >
    <CardHeader class="gap-1 px-4">
      <CardTitle class="flex flex-wrap items-center gap-2 text-sm">
        {{ title }}
        <Badge variant="outline">{{ executor.host }}</Badge>
        <Badge :variant="side === 'member' ? 'secondary' : 'default'">
          {{ side === 'member' ? '独占可加' : '相关性 · 不可加' }}
        </Badge>
      </CardTitle>
      <CardDescription class="text-xs">
        {{ batchCount }} 个批次 · {{ physicalSessions.length }} 个物理 session ·
        {{ side === 'member' ? '成员侧独立小计' : '与该成员相关的管理者执行汇总' }}
      </CardDescription>
      <div v-if="badges.length" class="flex flex-wrap gap-1 pt-1">
        <Badge
          v-for="badge in badges"
          :key="badge"
          :variant="badge.startsWith('共享') ? 'secondary' : 'outline'"
          >{{ badge }}</Badge
        >
      </div>
    </CardHeader>
    <CardContent class="flex min-w-0 flex-col gap-4 px-4">
      <TelemetryMetricGrid :metrics="totals" :columns="2" />
      <TelemetryContextCard
        :context-reference="contextReference"
        :columns="3"
        :title="
          side === 'member'
            ? '成员侧上下文参考'
            : '管理者侧上下文参考（相关批次最新采样）'
        "
      />
      <TelemetryCoveragePanel :coverage="coverage" />
      <p v-if="note" class="text-[11px] text-muted-foreground">{{ note }}</p>

      <Separator />
      <section class="flex min-w-0 flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="text-xs font-semibold">
            物理 session 累计（{{ physicalSessions.length }}）
          </h4>
          <Badge variant="outline">不与批次相加</Badge>
        </div>
        <p v-if="!physicalSessions.length" class="text-xs text-muted-foreground">
          暂无物理 session 观测。
        </p>
        <details
          v-for="session in physicalSessions"
          :key="session.instanceId"
          class="rounded-lg border p-2 text-xs"
          :data-manager-session-id="session.instanceId"
        >
          <summary class="flex cursor-pointer flex-wrap items-center gap-1">
            <Badge variant="outline">{{ session.host }}</Badge>
            <Badge variant="secondary">{{
              sessionStatusLabel(session.status)
            }}</Badge>
            <span class="font-mono break-all">{{ session.instanceId }}</span>
          </summary>
          <div class="mt-3 flex flex-col gap-3">
            <p class="text-muted-foreground">
              首次观测 {{ formatTimestamp(session.firstObservedAt) }} · 重置
              {{ formatTimestamp(session.resetAt) }}
            </p>
            <dl class="grid grid-cols-1 gap-1 text-[11px]">
              <div
                v-for="key in ['inputTokensTotal', 'outputTokens', 'totalTokens'] as const"
                :key="key"
                class="flex items-center justify-between gap-2"
              >
                <dt class="text-muted-foreground">{{ key }}</dt>
                <dd class="tabular-nums">
                  {{ metricDisplay(session.consumption[key], key) }}
                </dd>
              </div>
            </dl>
            <p class="text-[11px] text-muted-foreground">
              session 消耗为该物理 session 的累计视图，包含该 session 的全部回合，不按成员相关性过滤，不能与上方相关性汇总相加。
            </p>
          </div>
        </details>
      </section>
    </CardContent>
  </Card>
</template>
