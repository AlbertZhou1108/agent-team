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
import { formatTimestamp, sessionStatusLabel } from './format';

defineProps<{
  executor: TelemetryExecutor;
  totals: TelemetryMetrics;
  contextReference: TelemetryContextReference;
  physicalSessions: TelemetrySessionTelemetry[];
  batchCount: number;
  coverage: TelemetryCoverage;
  title?: string;
}>();

</script>

<template>
  <Card class="min-w-0 gap-4 py-4" :data-executor-id="executor.memberId">
    <CardHeader class="gap-1 px-4">
      <CardTitle class="flex flex-wrap items-center gap-2 text-sm">
        <span class="min-w-0 truncate" :title="title ?? executor.name">{{ title ?? executor.name }}</span>
        <Badge variant="outline">{{ executor.host }}</Badge>
        <Badge v-if="!coverage.complete" variant="outline">部分采集</Badge>
        <Badge v-if="executor.kind === 'panel_agent'" variant="secondary"
          >Panel Agent</Badge
        >
      </CardTitle>
      <CardDescription class="text-xs">
        {{ batchCount }} 个批次 ·
        {{ physicalSessions.length }} 个物理 session · 按执行归属汇总
      </CardDescription>
    </CardHeader>
    <CardContent class="flex min-w-0 flex-col gap-4 px-4">
      <p v-if="batchCount === 0 && totals.totalTokens.value == null" class="text-xs text-muted-foreground">暂无执行观测</p>
      <TelemetryMetricGrid v-else :metrics="totals" />
      <details class="text-xs text-muted-foreground">
        <summary class="w-fit cursor-pointer">上下文、会话与采集详情</summary>
        <div class="mt-3 flex max-h-[min(28rem,60vh)] min-w-0 flex-col gap-4 overflow-y-auto overscroll-contain pr-2 [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" role="region" aria-label="上下文、会话与采集详情内容" tabindex="0">
      <TelemetryContextCard :context-reference="contextReference" />
      <TelemetryCoveragePanel :coverage="coverage" />

      <Separator />
      <section class="flex min-w-0 flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <h4 class="text-xs font-semibold">
            物理 session 累计（{{ physicalSessions.length }}）
          </h4>
          <Badge variant="outline">不与批次相加</Badge>
        </div>
        <p
          v-if="!physicalSessions.length"
          class="text-xs text-muted-foreground"
        >
          暂无物理 session 观测。
        </p>
        <details
          v-for="session in physicalSessions"
          :key="session.instanceId"
          class="rounded-lg border p-2 text-xs"
          :data-session-id="session.instanceId"
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
              sessionKey {{ session.sessionKey }} · endpoint
              {{ session.endpointId }} · hostSessionId
              {{ session.hostSessionId ?? '未提供' }} · 首次观测
              {{ formatTimestamp(session.firstObservedAt) }} · 重置
              {{ formatTimestamp(session.resetAt) }}
            </p>
            <TelemetryMetricGrid
              :metrics="session.consumption"
              :show-detail="false"
              :columns="2"
            />
            <TelemetryContextCard
              :context-reference="session.contextReference"
              title="该物理 session 的上下文参考"
            />
            <TelemetryCoveragePanel :coverage="session.coverage" />
          </div>
        </details>
      </section>
      <slot name="footer" />
        </div>
      </details>
    </CardContent>
  </Card>
</template>
