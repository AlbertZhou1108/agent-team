<script setup lang="ts">
import { Crown, Radio } from '@lucide/vue';
import type { Member } from '@/shared/api/raw-types';
import { Badge } from '@/components/ui/badge';

defineProps<{
  members: Member[];
  runningMemberIds: Set<string>;
}>();
</script>

<template>
  <section class="member-list">
    <article v-for="member in members" :key="member.id" class="member-card member-row">
      <span class="member-avatar">{{ member.name.slice(0, 1) }}</span>
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <h3 class="truncate text-sm font-medium">{{ member.name }}</h3>
            <Crown v-if="member.role === 'lead'" :size="12" class="shrink-0 text-[var(--warning)]" />
          </div>
          <Badge v-if="runningMemberIds.has(member.id)" variant="accent">
            <Radio :size="10" class="animate-pulse" />
            运行中
          </Badge>
          <Badge v-else variant="default">{{ member.role === 'lead' ? '主 Agent' : '成员' }}</Badge>
        </div>
        <p class="mt-0.5 font-mono text-[10px] text-dim">{{ member.host }}</p>
        <p class="mt-2 line-clamp-3 text-xs leading-5 text-muted">
          {{ member.profile || '尚未提交能力自述' }}
        </p>
      </div>
    </article>
  </section>
</template>
