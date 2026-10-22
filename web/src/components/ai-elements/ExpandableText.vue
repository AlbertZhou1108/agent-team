<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { ChevronDown } from '@lucide/vue';

const props = withDefaults(defineProps<{ text: string; lines?: number }>(), { lines: 6 });
const body = ref<HTMLElement>();
const expanded = ref(false);
const animating = ref(false);
const overflowing = ref(false);
const measuredLineHeight = ref(0);
let observer: ResizeObserver | undefined;
let heightAnimation: Animation | undefined;

const collapsedHeight = computed(() => measuredLineHeight.value * props.lines);

function measure() {
  const element = body.value;
  if (!element) return;
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  measuredLineHeight.value = lineHeight;
  overflowing.value = element.scrollHeight > collapsedHeight.value + 1;
}
const bodyStyle = computed(() => (
  measuredLineHeight.value
    ? expanded.value
      ? undefined
      : { maxHeight: `${collapsedHeight.value}px` }
    : undefined
));

function toggleExpanded() {
  const element = body.value;
  if (!element) return;
  const next = !expanded.value;
  const from = element.getBoundingClientRect().height;
  const target = next
    ? element.scrollHeight
    : Math.min(collapsedHeight.value, element.scrollHeight);
  expanded.value = next;
  if (
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || Math.abs(target - from) < 1
  ) {
    heightAnimation?.cancel();
    heightAnimation = undefined;
    animating.value = false;
    return;
  }
  heightAnimation?.cancel();
  animating.value = true;
  const animation = element.animate(
    [
      { height: `${from}px` },
      { height: `${target}px` },
    ],
    {
      duration: 240,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      fill: 'both',
    },
  );
  heightAnimation = animation;
  animation.onfinish = () => {
    if (heightAnimation !== animation) return;
    heightAnimation = undefined;
    animating.value = false;
    animation.cancel();
    measure();
  };
}

watch([() => props.text, () => props.lines], async () => {
  heightAnimation?.cancel();
  heightAnimation = undefined;
  animating.value = false;
  expanded.value = false;
  await nextTick();
  measure();
});
onMounted(() => {
  observer = new ResizeObserver(measure);
  if (body.value) observer.observe(body.value);
  measure();
});
onBeforeUnmount(() => {
  observer?.disconnect();
  heightAnimation?.cancel();
});
</script>

<template>
  <div class="expandable-text">
    <div
      ref="body"
      class="expandable-text-body"
      :class="{
        'expandable-text-clamped': !expanded,
        'expandable-text-animating': animating,
      }"
      :style="bodyStyle"
    >
      <slot>{{ text }}</slot>
    </div>
    <button v-if="overflowing" type="button" class="expandable-text-toggle"
      :aria-expanded="expanded" :aria-label="expanded ? '收起全文' : '展开全文'"
      :title="expanded ? '收起全文' : '展开全文'" @click="toggleExpanded">
      <ChevronDown
        :size="16"
        aria-hidden="true"
        :class="{ 'rotate-180': expanded }"
      />
    </button>
  </div>
</template>
