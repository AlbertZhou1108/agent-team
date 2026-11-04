<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { computed } from 'vue';
import { compactNumber, numeric } from './visuals';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import type { TelemetryBatch } from '@/shared/api/raw-types';
import TelemetryMetricGrid from './TelemetryMetricGrid.vue';
import TelemetryContextCard from './TelemetryContextCard.vue';
import {
  batchHasExclusiveSubtotal,
  batchMergeLabels,
  batchStateLabel,
  completenessLabel,
  formatTimestamp,
  missingReasonLabel,
} from './format';

const props = defineProps<{
  batch: TelemetryBatch;
  shared?: boolean;
}>();

const mergeLabels = computed(() => batchMergeLabels(props.batch));
const completenessVariant = computed(() =>
  props.batch.completeness === 'partial' ? 'secondary' : 'outline',
);
const roleLabels: Record<
  TelemetryBatch['inputBatch']['messages'][number]['role'],
  string
> = {
  primary: '主消息',
  additional: '合并投递',
  note: '留言',
};
</script>

<template>
  <Disclosure variant="card" class="min-w-0">
    <template #summary>
      <span class="flex items-center justify-between gap-3">
        <span class="min-w-0 truncate font-medium">{{ batch.executor.name }}</span>
        <span class="shrink-0 tabular-nums">{{ compactNumber(numeric(batch.metrics.totalTokens)) }} token</span>
      </span>
      <span class="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span>{{ batchStateLabel(batch.state) }}</span>
        <span v-if="batch.completeness !== 'complete'">{{ completenessLabel(batch.completeness) }}</span>
        <span v-if="batch.anomalies.length" class="text-destructive">{{ batch.anomalies.length }} 项异常</span>
        <span>展开执行详情</span>
      </span>
    </template>
  <Card size="compact"
    class="min-w-0"
    :class="shared ? 'border-primary/50' : undefined"
    :data-batch-id="batch.batchId"
  >
    <CardHeader>
      <CardTitle class="break-all text-sm">
        {{ batch.frameworkTurnId }}
      </CardTitle>
      <CardDescription class="flex flex-wrap items-center gap-1 text-xs">
        <span>{{ batch.executor.name }} · {{ batch.executor.host }}</span>
        <Badge :variant="shared ? 'default' : 'outline'">{{
          batchStateLabel(batch.state)
        }}</Badge>
        <Badge :variant="completenessVariant">{{
          completenessLabel(batch.completeness)
        }}</Badge>
      </CardDescription>
    </CardHeader>
    <CardContent class="flex min-w-0 flex-col gap-4">
      <div class="flex flex-wrap gap-1">
        <Badge
          v-for="label in mergeLabels"
          :key="label"
          :variant="
            label === '跨来源' || label.startsWith('跨来源')
              ? 'default'
              : 'outline'
          "
          >{{ label }}</Badge
        >
        <Badge v-if="shared" variant="default">共同批次 · 独立展示</Badge>
      </div>

      <p class="text-xs text-muted-foreground">
        执行归属：{{ batch.executor.name }}（{{ batch.executor.memberId }}）·
        开始 {{ formatTimestamp(batch.startedAt) }} · 结束
        {{ formatTimestamp(batch.endedAt) }}
      </p>
      <p class="text-xs text-muted-foreground">
        物理 session：{{ batch.physicalSession.instanceId }} · {{
          batch.physicalSession.sessionKey
        }}
        · endpoint {{ batch.physicalSession.endpointId }} · hostSessionId
        {{ batch.physicalSession.hostSessionId ?? '未提供' }}
      </p>

      <section class="flex min-w-0 flex-col gap-2">
        <div class="flex flex-wrap items-center gap-1">
          <h4 class="text-xs font-semibold">输入批次</h4>
          <Badge variant="outline"
            >{{ batch.inputBatch.messages.length }} 条消息</Badge
          >
          <Badge variant="outline"
            >{{ batch.inputBatch.merge.sourceCount }} 个来源</Badge
          >
          <Badge variant="outline">整批归执行方一次</Badge>
        </div>
        <ul class="flex flex-col gap-1 text-xs">
          <li
            v-for="message in batch.inputBatch.messages"
            :key="message.messageId"
            class="flex min-w-0 flex-wrap items-center gap-1"
          >
            <Badge variant="secondary">{{ roleLabels[message.role] }}</Badge>
            <span class="font-medium">{{ message.senderName }}</span>
            <span class="break-all font-mono text-muted-foreground">{{
              message.messageId
            }}</span>
          </li>
        </ul>
        <p class="text-2xs text-muted-foreground">
          来源成员：{{
            batch.inputBatch.sourceActors
              .map(actor => `${actor.actorName}（${actor.messageIds.length}）`)
              .join('、') || '未记录'
          }}
        </p>
      </section>

      <Separator />

      <TelemetryMetricGrid :metrics="batch.metrics" />
      <TelemetryContextCard
        :context-reference="batch.contextReference"
        title="该批次最近请求采样"
      />

      <Alert v-if="batch.anomalies.length" variant="destructive">
        <AlertDescription>
          <p class="font-medium">异常（保留原值，不静默修正）</p>
          <ul class="mt-1 flex flex-col gap-1 text-xs">
            <li v-for="(anomaly, index) in batch.anomalies" :key="index">
              {{ anomaly.code }} · {{ anomaly.detail }}
              <span v-if="anomaly.fields.length"
                >（{{ anomaly.fields.join(', ') }}）</span
              >
            </li>
          </ul>
        </AlertDescription>
      </Alert>

      <Disclosure>
        <template #summary>
          尝试视图（{{ batch.attempts.length }}）· 不与批次指标相加
        </template>
        <div class="mt-2 flex flex-col gap-2">
          <p v-if="!batch.attempts.length" class="text-muted-foreground">
            无尝试级记录。
          </p>
          <div
            v-for="attempt in batch.attempts"
            :key="attempt.attemptId"
          ><Card size="compact"><CardContent class="flex min-w-0 flex-col gap-2">
            <div class="flex flex-wrap items-center gap-1">
              <span class="font-mono break-all">{{ attempt.attemptId }}</span>
              <Badge variant="outline">{{ batchStateLabel(attempt.state) }}</Badge>
              <Badge variant="outline">{{
                completenessLabel(attempt.completeness)
              }}</Badge>
              <span v-if="attempt.hostTurnRef" class="text-muted-foreground"
                >原生回合 {{ attempt.hostTurnRef }}</span
              >
            </div>
            <div v-if="attempt.metrics" class="mt-2">
              <TelemetryMetricGrid
                :metrics="attempt.metrics"
                :show-detail="false"
                :columns="2"
              />
            </div>
            <p v-else class="mt-2 text-muted-foreground">
              无独立尝试级指标视图；已知部分保留在批次指标中。null 不等于 0，不推断为未消耗。
            </p>
          </CardContent></Card></div>
        </div>
      </Disclosure>

      <Disclosure>
        <template #summary>
          来源回查（{{ batch.provenance.length }}）
        </template>
        <ul class="mt-2 flex flex-col gap-1">
          <li
            v-for="(item, index) in batch.provenance"
            :key="index"
            class="break-all text-muted-foreground"
          >
            {{ item.source }} · {{ item.scope }}/{{ item.aggregation }} · event
            {{ item.eventSeq ?? '—' }} · nativeTurn
            {{ item.nativeTurnId ?? '—' }} · sampled
            {{ formatTimestamp(item.observedAt) }}
          </li>
          <li v-if="!batch.provenance.length" class="text-muted-foreground">
            无来源记录。
          </li>
        </ul>
      </Disclosure>
      <p v-if="batch.attempts.some(attempt => attempt.metrics === null)" class="text-2xs text-muted-foreground">
        部分尝试无独立指标视图（null），null 不等于 0，不推断为未消耗；其已知用量仍在批次指标内。缺失原因示例：{{
          missingReasonLabel('not_captured')
        }}。
      </p>
    </CardContent>
  </Card>
  </Disclosure>
</template>
