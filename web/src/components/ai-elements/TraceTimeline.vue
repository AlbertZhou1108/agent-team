<script setup lang="ts">
import { AlertTriangle, CheckCircle2, CircleDot, LoaderCircle } from '@lucide/vue';
import type { TurnView } from '@/shared/models/view-types';
import TraceStepCard from './TraceStepCard.vue';

defineProps<{ turns: TurnView[] }>();
</script>

<template>
  <div class="space-y-4">
    <section v-for="turn in turns" :key="turn.id" class="trace-turn">
      <header class="mb-3 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="font-mono text-[10px] uppercase tracking-[0.16em] text-dim">TURN</p>
          <p class="truncate font-mono text-[11px] text-muted">{{ turn.id === 'unknown' ? '未关联回合' : turn.id }}</p>
        </div>
        <span :class="['turn-status', `turn-${turn.status}`]">
          <LoaderCircle v-if="turn.status === 'running'" :size="12" class="animate-spin" />
          <CheckCircle2 v-else-if="turn.status === 'completed'" :size="12" />
          <AlertTriangle v-else-if="turn.status === 'error'" :size="12" />
          <CircleDot v-else :size="12" />
          {{ turn.status === 'running' ? '运行中' : turn.status === 'completed' ? '已完成' : turn.status === 'error' ? '失败' : '状态未知' }}
        </span>
      </header>
      <div class="space-y-1 border-l border-[var(--border)] pl-3">
        <TraceStepCard v-for="step in turn.steps" :key="step.id" :step="step" />
      </div>
    </section>
    <div v-if="!turns.length" class="empty-state">还没有可展示的执行轨迹。</div>
  </div>
</template>
