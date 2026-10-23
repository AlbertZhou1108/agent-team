<script setup lang="ts">
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
  <details class="min-w-0 rounded-lg border p-3">
    <summary class="flex cursor-pointer flex-col gap-1 text-xs">
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
    </summary>
  <Card
    class="min-w-0 gap-3 py-4"
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
    <CardHeader class="gap-1 px-4">
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
        <Badge :variant="completenessVariant">{{
          completenessLabel(batch.completeness)
        }}</Badge>
      </CardDescription>
    </CardHeader>
    <CardContent class="flex min-w-0 flex-col gap-4 px-4">
      <div class="flex flex-wrap gap-1">
        <Badge
          v-for="label in mergeLabels"
          :key="label"
          :variant="label === '合并投递' ? 'default' : 'outline'"
          >{{ label }}</Badge
        >
        <Badge variant="outline">整批归执行方一次</Badge>
        <Badge v-if="batch.involvement?.exclusiveToMember" variant="secondary"
          >独占批次</Badge
        >
        <Badge
          v-if="batch.involvement?.sharedWithOtherMembers"
          variant="secondary"
          >共享批次 · 整批展示</Badge
        >
      </div>

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
        <p class="text-[11px] text-muted-foreground">
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
            <span class="break-all font-mono text-[10px] text-muted-foreground">{{
              message.messageId
            }}</span>
          </li>
        </ul>
        <p class="text-[11px] text-muted-foreground">
          输出触达仅用于相关性判断，不改变执行归属，也不拆分整批消耗。
        </p>
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

      <details class="text-xs text-muted-foreground">
        <summary class="w-fit cursor-pointer">
          来源与完整性 · 批次 {{ completenessLabel(batch.completeness) }}
        </summary>
        <div class="mt-2 flex flex-col gap-1">
          <p v-if="batch.completeness !== 'complete'">
            未完整批次不补零；缺失字段显示“—”与原因。
          </p>
          <div class="flex flex-wrap gap-1">
            <Badge
              v-for="key in ['inputTokensTotal', 'outputTokens', 'totalTokens'] as const"
              :key="key"
              variant="outline"
              :data-manager-metric-key="key"
            >
              {{ key }}：
              {{ batch.metrics[key].value == null ? '—' : batch.metrics[key].value }}
              <template v-if="batch.metrics[key].value == null">
                （{{ missingReasonLabel(batch.metrics[key].missingReason) }}）
              </template>
            </Badge>
          </div>
        </div>
      </details>
    </CardContent>
  </Card>
  </details>
</template>
