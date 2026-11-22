<script setup lang="ts">
/**
 * 折叠显现原语(行为契约的最小承载):
 * 条件渲染的显隐场景以一行接入统一的展开收起动效
 * (grid-rows 0fr→1fr,逐帧解析真实布局,终点不变式由构造保证)。
 * 与共享 Collapsible 同源同节奏(消费 --component-disclosure-duration/-easing),
 * 收起完成后延迟 visibility 隐藏,收起动画可见且内容不可聚焦。
 */
import { nextTick, onMounted, ref, watch } from 'vue';
const props = defineProps<{ show: boolean; id?: string }>();
const content = ref<HTMLElement>();
const clip = ref<HTMLElement>();

function warnIfEmptySlot() {
  if (!import.meta.env.DEV || !clip.value) return;
  const emptyElements = clip.value.childElementCount === 0;
  const emptyText = (clip.value.textContent ?? '').trim() === '';
  if (emptyElements && emptyText) {
    console.error(
      '[CollapseReveal] 禁止在内部直接子节点使用 v-if，否则收起动画会被立即截断。',
    );
  }
}

onMounted(warnIfEmptySlot);

watch(() => props.show, show => {
  if (!show && props.id && content.value?.contains(document.activeElement)) {
    document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(props.id)}"]`)?.focus();
  }
  void nextTick(warnIfEmptySlot);
});
</script>

<template>
  <div ref="content" :id="id" class="collapse-reveal" :data-open="show" :inert="!show">
    <div ref="clip" class="collapse-reveal-clip">
      <slot />
    </div>
  </div>
</template>
