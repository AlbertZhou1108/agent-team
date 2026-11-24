<script setup lang="ts">
// 全贴边主工作面容器（方案 A）：不再用圆角外框卡片包裹主区，
// 直接消费 content-surface 表面底色（L1），顶栏/底栏经 MessageFeed 的 bar-* 落在滚动区内。
</script>

<template>
  <div
    data-component="content-surface"
    class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card text-card-foreground"
  >
    <slot />
  </div>
</template>
