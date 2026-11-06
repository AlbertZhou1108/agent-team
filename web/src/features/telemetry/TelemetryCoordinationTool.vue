<script setup lang="ts">
/** 工具页挂载的协调会话用量:复用总用量视图,固定 coordination 形态。 */
import TelemetryUsageView from './TelemetryUsageView.vue';

defineProps<{ groupId?: string }>();
</script>

<template>
  <TelemetryUsageView v-if="groupId" :group-id="groupId" kind="coordination" />
</template>
