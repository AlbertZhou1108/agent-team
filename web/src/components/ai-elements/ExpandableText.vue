<script setup lang="ts">
import { Button } from '@/components/ui/button';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  useId,
} from 'vue';
import { ChevronDown } from '@lucide/vue';

const props = withDefaults(defineProps<{ text: string; lines?: number }>(), {
  lines: 6,
});
const bodyId = useId();
const body = ref<HTMLElement>();
const content = ref<HTMLElement>();
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
const bodyStyle = computed(() =>
  measuredLineHeight.value
    ? expanded.value
      ? undefined
      : { maxHeight: `${collapsedHeight.value}px` }
    : undefined,
);

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
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    Math.abs(target - from) < 1
  ) {
    heightAnimation?.cancel();
    heightAnimation = undefined;
    animating.value = false;
    return;
  }
  heightAnimation?.cancel();
  animating.value = true;
  const animation = element.animate(
    [{ height: `${from}px` }, { height: `${target}px` }],
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
  if (content.value) observer.observe(content.value);
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
      :id="bodyId"
      ref="body"
      class="expandable-text-body"
      :class="{
        'expandable-text-clamped': !expanded,
        'expandable-text-animating': animating,
      }"
      :style="bodyStyle"
    >
      <div ref="content">
        <slot><span class="whitespace-pre-wrap">{{ text }}</span></slot>
      </div>
    </div>
    <Button
      v-if="overflowing"
      type="button"
      variant="ghost"
      size="sm"
      class="mt-2 flex"
      :aria-controls="bodyId"
      :aria-expanded="expanded"
      :aria-label="expanded ? '收起全文' : '展开全文'"
      :title="expanded ? '收起全文' : '展开全文'"
      @click="toggleExpanded"
    >
      {{ expanded ? '收起全文' : '展开全文' }}
      <ChevronDown
        data-icon="inline-end"
        aria-hidden="true"
        :class="{ 'rotate-180': expanded }"
      />
    </Button>
  </div>
</template>
