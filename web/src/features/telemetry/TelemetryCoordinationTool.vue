<script setup lang="ts">
/**
 * 工具页挂载的全局统一遥测入口：汇聚团队协调总用量、成员消耗对比、
 * 执行详情与来源分析，避免在成员页与详情页多处重复平铺 9 项指标。
 */
import { Separator } from '@/components/ui/separator';
import TelemetryUsageView from './TelemetryUsageView.vue';
import TelemetryMembersView from './TelemetryMembersView.vue';

defineProps<{ groupId?: string; selectedMemberId?: string }>();
</script>

<template>
  <div v-if="groupId" class="flex min-w-0 flex-col gap-5">
    <TelemetryUsageView :group-id="groupId" kind="coordination" />
    <Separator />
    <TelemetryMembersView :group-id="groupId" :selected-member-id="selectedMemberId" />
  </div>
</template>
