<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
  <Card size="compact"
    class="min-w-0 "
    :data-manager-side="side"
    :data-manager-side-executor="executor.memberId"
  >
    <CardHeader>
      <CardTitle class="flex flex-wrap items-center gap-2 text-sm">
        {{ title }}
        <Badge variant="outline">{{ executor.host }}</Badge>
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
    <CardContent class="flex min-w-0 flex-col gap-4">
      <TelemetryMetricGrid :metrics="totals" :columns="2" />
      <Separator />
      <Disclosure>
        <template #summary>上下文、会话与采集详情</template>
        <ScrollRegion
          label="上下文、会话与采集详情内容"
          max-height="min(28rem,60vh)"
          gap="1rem"
        >
          <TelemetryContextSection
            :context-reference="contextReference"
            :columns="3"
            :title="
              side === 'member'
                ? '成员侧上下文参考'
                : '管理者侧上下文参考（相关批次最新采样）'
            "
          />

          <Separator />
          <section class="flex min-w-0 flex-col gap-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h4 class="text-xs font-semibold">
                物理 session 累计（{{ physicalSessions.length }}）
              </h4>
            </div>
            <p v-if="!physicalSessions.length" class="text-xs text-muted-foreground">
              暂无物理 session 观测。
            </p>
            <div v-else class="divide-y divide-border">
              <Disclosure
                v-for="session in physicalSessions"
                :key="session.instanceId"
                :data-manager-session-id="session.instanceId"
              >
                <template #summary>
                  <Badge variant="outline">{{ session.host }}</Badge>
                  <Badge variant="secondary">{{
                    sessionStatusLabel(session.status)
                  }}</Badge>
                  <span class="font-mono break-all">{{ session.instanceId }}</span>
                </template>
                <div class="flex flex-col gap-3">
                  <p class="text-muted-foreground">
                    首次观测 {{ formatTimestamp(session.firstObservedAt) }} · 重置
                    {{ formatTimestamp(session.resetAt) }}
                  </p>
                  <dl class="grid grid-cols-1 gap-1 text-2xs">
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
                  <p class="text-2xs text-muted-foreground">
                    session 消耗为该物理 session 的累计视图，包含该 session 的全部回合，不按成员相关性过滤，不能与上方相关性汇总相加。
                  </p>
                </div>
              </Disclosure>
            </div>
          </section>
        </ScrollRegion>
      </Disclosure>
    </CardContent>
  </Card>
</template>
