<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronDown, ChevronUp } from '@lucide/vue';

const props = withDefaults(defineProps<{ text: string; lines?: number }>(), { lines: 6 });
const body = ref<HTMLElement>();
const expanded = ref(false);
const overflowing = ref(false);
let observer: ResizeObserver | undefined;

function measure() {
  const element = body.value;
  if (!element) return;
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  overflowing.value = element.scrollHeight > lineHeight * props.lines + 1;
}
watch(() => props.text, async () => {
  expanded.value = false;
  await nextTick();
  measure();
});
onMounted(() => {
  observer = new ResizeObserver(measure);
  if (body.value) observer.observe(body.value);
  measure();
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="expandable-text">
    <p ref="body" :class="{ 'expandable-text-clamped': !expanded }" :style="{ '-webkit-line-clamp': lines }">{{ text }}</p>
    <button v-if="overflowing" type="button" class="expandable-text-toggle"
      :aria-expanded="expanded" :aria-label="expanded ? '收起全文' : '展开全文'"
      :title="expanded ? '收起全文' : '展开全文'" @click="expanded = !expanded">
      <ChevronUp v-if="expanded" :size="16" aria-hidden="true" />
      <ChevronDown v-else :size="16" aria-hidden="true" />
    </button>
  </div>
</template>
