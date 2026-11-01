<script setup lang="ts">
/**
 * 折叠显现原语(行为契约的最小承载):
 * 条件渲染的显隐场景以一行接入统一的展开收起动效
 * (grid-rows 0fr→1fr,逐帧解析真实布局,终点不变式由构造保证)。
 * 与共享 Collapsible 同源同节奏(--motion-duration-normal × 风格档),
 * 收起完成后延迟 visibility 隐藏,收起动画可见且内容不可聚焦。
 */
import { ref, watch } from 'vue';
const props = defineProps<{ show: boolean; id?: string }>();
const content = ref<HTMLElement>();
watch(() => props.show, show => {
  if (!show && props.id && content.value?.contains(document.activeElement)) {
    document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(props.id)}"]`)?.focus();
  }
});
</script>

<template>
  <div ref="content" :id="id" class="collapse-reveal" :data-open="show" :inert="!show">
    <div class="collapse-reveal-clip">
      <slot />
    </div>
  </div>
</template>
