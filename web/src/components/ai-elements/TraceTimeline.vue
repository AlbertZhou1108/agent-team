<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import PanelState from '@/components/panel/PanelState.vue';
import RecordPanel from '@/components/panel/RecordPanel.vue';
import { ItemGroup } from '@/components/ui/item';
import { Badge } from '@/components/ui/badge';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  LoaderCircle,
} from '@lucide/vue';
import type { TurnView } from '@/shared/models/view-types';
import TraceStepCard from './TraceStepCard.vue';

defineProps<{ turns: TurnView[] }>();
</script>

<template>
  <ItemGroup class="gap-4">
    <RecordPanel v-for="(turn, index) in turns" :key="turn.id"
      :title="turn.id === 'unknown' ? '未关联回合' : `回合 ${index + 1}`"
      :count="turn.steps.length"
      count-label="步"
      :description="`源事件 #${turn.firstSeq}–#${turn.lastSeq}`">
        <template #status>
          <Badge
            :variant="
              turn.status === 'error'
                ? 'destructive'
                : turn.status === 'running'
                  ? 'secondary'
                  : 'outline'
            "
          >
            <LoaderCircle
              v-if="turn.status === 'running'"
              class="animate-spin"
            /><CheckCircle2
              v-else-if="turn.status === 'completed'"
            /><AlertTriangle v-else-if="turn.status === 'error'" /><CircleDot
              v-else
            />
            {{
              turn.status === 'running'
                ? '运行中'
                : turn.status === 'completed'
                  ? '已完成'
                  : turn.status === 'error'
                    ? '失败'
                    : '状态未知'
            }}
          </Badge>
        </template>
        <div class="flex flex-col">
          <TraceStepCard
            v-for="step in turn.steps"
            :key="step.id"
            :step="step"
            data-record-row
          />
        </div>
        <template v-if="turn.id !== 'unknown'" #footer>
        <Disclosure

        >
          <template #summary>回合标识</template>
          <p class="mt-2 break-all font-mono">{{ turn.id }}</p>
        </Disclosure>
        </template>
    </RecordPanel>
    <PanelState v-if="!turns.length" :icon="CircleDot" title="暂无执行轨迹" description="会话开始执行后，步骤和结果会显示在这里。" />
  </ItemGroup>
</template>
