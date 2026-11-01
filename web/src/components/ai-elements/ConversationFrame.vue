<script setup lang="ts">
import { Card, CardContent } from '@/components/ui/card';

// 会话帧只是带边框的容器;顶栏/底栏经 MessageFeed 的 bar-* 插槽落在
// 滚动区内(overlay 结构,内容从栏下穿过),不再由帧本身排位。
</script>

<template>
  <Card class="min-h-0 min-w-0 gap-0 overflow-hidden py-0">
    <CardContent class="flex min-h-0 min-w-0 flex-1 flex-col px-0">
      <slot />
    </CardContent>
  </Card>
</template>
