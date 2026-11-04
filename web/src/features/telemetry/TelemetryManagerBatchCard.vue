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
import type {
  TelemetryManagerBatch,
  TelemetryOutgoingMessage,
} from '@/shared/api/raw-types';
import TelemetryMetricGrid from './TelemetryMetricGrid.vue';
import TelemetryContextCard from './TelemetryContextCard.vue';
import {
  batchMergeLabels,
  batchStateLabel,
  completenessLabel,
  formatTimestamp,
  missingReasonLabel,
} from './format';

const props = defineProps<{
  batch: TelemetryManagerBatch;
  memberNames: Record<string, string>;
}>();

const mergeLabels = computed(() => batchMergeLabels(props.batch));
const involvementLabel = computed(() => {
  const involvement = props.batch.involvement;
  if (!involvement) return '成员侧';
  if (involvement.exclusiveToMember) return '独占';
  if (involvement.sharedWithOtherMembers) return '共享';
  return '相关';
});
const involvedNames = computed(() =>
  (props.batch.involvement?.involvedMemberIds ?? []).map(
    id => props.memberNames[id] ?? id,
  ),
);
const outgoingSummary = computed(() =>
  props.batch.outgoingMessages.map(message => ({
    ...message,
    recipientKindLabel: recipientKindLabel(message.recipientKind),
    kindLabel: message.kind === 'send' ? '发送' : '留言',
  })),
);
const completenessVariant = computed(() =>
  props.batch.completeness === 'partial' ? 'secondary' : 'outline',
);

function recipientKindLabel(
  kind: TelemetryOutgoingMessage['recipientKind'],
): string {
  return {
    member: '成员',
    user: '用户',
    panel_agent: 'Panel Agent',
    other: '其他',
  }[kind];
}
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
        <span v-if="batch.anomalies.length" class="text-destructive">{{ batch.anomalies.length }} 项异常</span>
        <span>展开执行详情</span>
      </span>
    </template>
  <Card size="compact"
    class="min-w-0"
    :data-batch-id="batch.batchId"
    :data-manager-batch-id="batch.batchId"
    :data-side="batch.side"
    :data-involvement="
      batch.involvement
        ? batch.involvement.exclusiveToMember
          ? 'exclusive'
          : batch.involvement.sharedWithOtherMembers
            ? 'shared'
            : 'related'
        : 'none'
    "
  >
    <CardHeader>
      <CardTitle class="break-all text-sm">
        {{ batch.frameworkTurnId }}
      </CardTitle>
      <CardDescription class="flex flex-wrap items-center gap-1 text-xs">
        <Badge :variant="batch.side === 'manager' ? 'default' : 'secondary'">
          {{ batch.side === 'manager' ? '管理者侧' : '成员侧' }}
        </Badge>
        <span>{{ batch.executor.name }} · {{ batch.executor.host }}</span>
        <Badge :variant="batch.side === 'manager' ? 'default' : 'outline'">
          {{ involvementLabel }}
        </Badge>
        <Badge variant="outline">{{ batchStateLabel(batch.state) }}</Badge>
      </CardDescription>
    </CardHeader>
    <CardContent class="flex min-w-0 flex-col gap-4">
      <p
        v-if="batch.involvement"
        class="text-xs text-muted-foreground"
        data-manager-involved
      >
        涉及成员：{{ involvedNames.join('、') || '未记录' }}
        <template v-if="batch.involvement.sharedWithOtherMembers">
          · 同一批次会出现在其他成员视图中，不能相加
        </template>
      </p>

      <p class="text-xs text-muted-foreground">
        执行归属：{{ batch.executor.name }}（{{ batch.executor.memberId }}）·
        开始 {{ formatTimestamp(batch.startedAt) }} · 结束
        {{ formatTimestamp(batch.endedAt) }}
      </p>
      <p class="text-xs text-muted-foreground">
        物理 session：{{ batch.physicalSession.instanceId }} · {{
          batch.physicalSession.sessionKey
        }}
        · endpoint {{ batch.physicalSession.endpointId }}
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
        </div>
        <p class="text-2xs text-muted-foreground">
          来源成员：{{
            batch.inputBatch.sourceActors
              .map(actor => `${actor.actorName}（${actor.messageIds.length}）`)
              .join('、') || '未记录'
          }}
        </p>
      </section>

      <section
        v-if="batch.outgoingMessages.length"
        class="flex min-w-0 flex-col gap-2"
        data-manager-outgoing
      >
        <div class="flex flex-wrap items-center gap-1">
          <h4 class="text-xs font-semibold">回合输出触达</h4>
          <Badge variant="outline"
            >{{ batch.outgoingMessages.length }} 条元数据</Badge
          >
          <Badge variant="outline">不含正文</Badge>
        </div>
        <ul class="flex flex-col gap-1 text-xs">
          <li
            v-for="message in outgoingSummary"
            :key="message.messageId"
            class="flex min-w-0 flex-wrap items-center gap-1"
          >
            <Badge variant="secondary">{{ message.kindLabel }}</Badge>
            <span class="font-medium">{{ message.recipientName }}</span>
            <Badge variant="outline">{{ message.recipientKindLabel }}</Badge>
            <span class="break-all font-mono text-2xs text-muted-foreground">{{
              message.messageId
            }}</span>
          </li>
        </ul>
      </section>

      <Separator />

      <TelemetryMetricGrid :metrics="batch.metrics" :columns="2" />
      <TelemetryContextCard
        :context-reference="batch.contextReference"
        title="该批次最近请求采样"
      />

      <Alert v-if="batch.anomalies.length" variant="destructive">
        <AlertDescription>
          <p class="font-medium">异常（保留原值，不静默修正）</p>
          <ul class="mt-1 flex flex-col gap-1 text-xs">
            <li v-for="anomaly in batch.anomalies" :key="anomaly.code">
              {{ anomaly.code }} · {{ anomaly.fields.join(', ') }} ·
              {{ anomaly.detail }}
            </li>
          </ul>
        </AlertDescription>
      </Alert>

      <Disclosure>
        <template #summary>
          来源与完整性
        </template>
        <div class="mt-2 flex flex-col gap-1">
          <div class="flex flex-wrap gap-1">
            <Badge
              v-for="key in ['inputTokensTotal', 'outputTokens', 'totalTokens'] as const"
              :key="key"
              variant="outline"
              :data-manager-metric-key="key"
            >
              {{ key }}：
              {{ batch.metrics[key].value == null ? '—' : batch.metrics[key].value }}
            </Badge>
          </div>
        </div>
      </Disclosure>
    </CardContent>
  </Card>
  </Disclosure>
</template>
