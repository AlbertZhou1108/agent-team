<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { computed } from 'vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Gauge } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import { useTelemetryCapabilitiesQuery } from '@/features/queries';
import type { TelemetryCapabilityResponse } from '@/shared/api/raw-types';
import {
  CONTEXT_METRIC_LABELS,
  METRIC_KEYS,
  METRIC_LABELS,
  capabilityLabel,
  formatTimestamp,
} from './format';

const props = defineProps<{ groupId: string }>();

const query = useTelemetryCapabilitiesQuery(() => props.groupId || undefined);
const data = computed(() => query.data.value);

type CapabilityKey =
  | (typeof METRIC_KEYS)[number]
  | keyof typeof CONTEXT_METRIC_LABELS;

const capabilityKeys: CapabilityKey[] = [
  ...METRIC_KEYS,
  ...(Object.keys(CONTEXT_METRIC_LABELS) as Array<
    keyof typeof CONTEXT_METRIC_LABELS
  >),
];

function rowLabel(key: CapabilityKey): string {
  return key in METRIC_LABELS
    ? METRIC_LABELS[key as keyof typeof METRIC_LABELS]
    : CONTEXT_METRIC_LABELS[key as keyof typeof CONTEXT_METRIC_LABELS];
}

function capabilityVariant(capability: 'direct' | 'derived' | 'unsupported') {
  if (capability === 'direct') return 'default' as const;
  if (capability === 'derived') return 'secondary' as const;
  return 'outline' as const;
}

type HostCapability = TelemetryCapabilityResponse['hosts'][number];

function capabilityCount(
  host: HostCapability,
  kind: 'direct' | 'derived' | 'unsupported',
) {
  return capabilityKeys.filter(
    key => host.metrics[key]?.capability === kind,
  ).length;
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-1">
        <h3 class="text-sm font-semibold">宿主能力声明</h3>
        <Badge variant="outline">不触发采集</Badge>
        <Badge variant="outline">只读</Badge>
      </div>
      <span class="text-2xs text-muted-foreground"
        >更新 {{ formatTimestamp(data?.generatedAt ?? null) }}</span
      >
    </div>
    <p class="text-xs text-muted-foreground">
      区分“宿主不支持”“支持但本次未报告”和“数据不完整”。能力声明不等于每条记录都有值；单条记录仍以
      Metric 的 value / completeness / missingReason 为准。
    </p>

    <PanelState
      v-if="query.isPending.value"
      loading
      title="正在读取能力声明"
      description="等待服务端返回宿主适配器能力。"
    />
    <Alert v-else-if="query.error.value" variant="destructive">
      <AlertDescription
        >读取能力声明失败：{{ query.error.value.message }}</AlertDescription
      >
    </Alert>
    <PanelState
      v-else-if="!data?.hosts.length"
      :icon="Gauge"
      title="暂无能力声明"
      description="当前群涉及的宿主适配器尚未返回能力声明。"
    />
    <Card size="compact"
      v-for="host in data?.hosts ?? []"
      :key="host.host"
      class="min-w-0"
      :data-capability-host="host.host"
    >
      <CardHeader>
        <CardTitle class="flex flex-wrap items-center gap-2 text-sm">
          {{ host.host }}
          <Badge variant="outline"
            >直接 {{ capabilityCount(host, 'direct') }}</Badge
          >
          <Badge variant="secondary"
            >派生 {{ capabilityCount(host, 'derived') }}</Badge
          >
          <Badge variant="outline"
            >不支持 {{ capabilityCount(host, 'unsupported') }}</Badge
          >
        </CardTitle>
        <CardDescription class="text-xs"
          >共 {{ capabilityKeys.length }} 个统一指标字段</CardDescription
        >
      </CardHeader>
      <CardContent>
        <Disclosure>
          <template #summary>展开 12 项能力明细</template>
          <ul class="mt-2 flex flex-col gap-2">
            <li
              v-for="key in capabilityKeys"
              :key="key"
              :data-capability-key="key"
            ><Card size="compact"><CardContent class="flex min-w-0 flex-col gap-2">
              <div class="flex flex-wrap items-center gap-1">
                <span class="font-medium">{{ rowLabel(key) }}</span>
                <Badge :variant="capabilityVariant(host.metrics[key].capability)">{{
                  capabilityLabel(host.metrics[key].capability)
                }}</Badge>
                <span class="break-all font-mono text-muted-foreground">{{
                  host.metrics[key].source
                }}</span>
              </div>
              <p v-if="host.metrics[key].requires.length" class="mt-1 text-muted-foreground">
                所需：{{ host.metrics[key].requires.join('、') }}
              </p>
              <p
                v-if="host.metrics[key].completenessConditions.length"
                class="text-muted-foreground"
              >
                完整性条件：{{
                  host.metrics[key].completenessConditions.join('、')
                }}
              </p>
              <p v-if="host.metrics[key].note" class="text-muted-foreground">
                说明：{{ host.metrics[key].note }}
              </p>
            </CardContent></Card></li>
          </ul>
        </Disclosure>
      </CardContent>
    </Card>
  </div>
</template>
