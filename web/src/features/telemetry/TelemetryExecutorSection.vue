<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollRegion } from '@/components/ui/scroll-region';
import type {
  TelemetryContextReference,
  TelemetryCoverage,
  TelemetryExecutor,
  TelemetryMetrics,
  TelemetrySessionTelemetry,
} from '@/shared/api/raw-types';
import TelemetryMetricGrid from './TelemetryMetricGrid.vue';
import TelemetryContextSection from './TelemetryContextSection.vue';
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
  <!-- 遥测视图都活在带边框的上下文面板里,这里只做分区,不再自带卡片外壳。 -->
  <section class="flex min-w-0 flex-col gap-4" :data-executor-id="executor.memberId">
    <header class="flex min-w-0 flex-col gap-1">
      <h4 class="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <span class="min-w-0 truncate" :title="title ?? executor.name">{{ title ?? executor.name }}</span>
        <Badge variant="outline">{{ executor.host }}</Badge>
        <Badge v-if="!coverage.complete" variant="outline">部分采集</Badge>
        <Badge v-if="executor.kind === 'panel_agent'" variant="secondary"
          >Panel Agent</Badge
        >
      </h4>
      <p class="text-xs text-muted-foreground">
        {{ batchCount }} 个回合 ·
        {{ physicalSessions.length }} 个物理 session · 按执行归属汇总
      </p>
    </header>
    <div class="flex min-w-0 flex-col gap-4">
      <p v-if="batchCount === 0 && totals.totalTokens.value == null" class="text-xs text-muted-foreground">暂无执行观测</p>
      <TelemetryMetricGrid v-else :metrics="totals" />
      <Separator />
      <Disclosure>
        <template #summary>上下文、会话与采集详情</template>
        <ScrollRegion
          label="上下文、会话与采集详情内容"
          max-height="min(28rem,60vh)"
          gap="1rem"
        >
          <TelemetryContextSection :context-reference="contextReference" />
          <Separator />
          <section class="flex min-w-0 flex-col gap-2">
            <div class="flex items-center justify-between gap-2">
              <h4 class="text-xs font-semibold">
                物理 session 累计（{{ physicalSessions.length }}）
              </h4>
            </div>
            <p
              v-if="!physicalSessions.length"
              class="text-xs text-muted-foreground"
            >
              暂无物理 session 观测。
            </p>
            <div v-else class="divide-y divide-border">
              <Disclosure
                v-for="session in physicalSessions"
                :key="session.instanceId"
                :data-session-id="session.instanceId"
              >
                <template #summary>
                  <Badge variant="outline">{{ session.host }}</Badge>
                  <Badge variant="secondary">{{
                    sessionStatusLabel(session.status)
                  }}</Badge>
                  <span class="font-mono break-all">{{ session.instanceId }}</span>
                </template>
                <p class="text-xs text-muted-foreground">
                  sessionKey {{ session.sessionKey }} · endpoint
                  {{ session.endpointId }} · hostSessionId
                  {{ session.hostSessionId ?? '未提供' }} · 首次观测
                  {{ formatTimestamp(session.firstObservedAt) }} · 重置
                  {{ formatTimestamp(session.resetAt) }}
                </p>
              </Disclosure>
            </div>
          </section>
          <slot name="footer" />
        </ScrollRegion>
      </Disclosure>
    </div>
  </section>
</template>
