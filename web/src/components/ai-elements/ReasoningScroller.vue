<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';

/**
 * 思考过程滚动区。宿主按帧推送增量,内容会持续增高:
 * - 用户停留在底部时跟随最新内容(scrollTop 贴住 scrollHeight);
 * - 用户主动向上阅读后不再抢占位置,避免读到哪里被拽走。
 * 与会话滚动区同一套"贴底才跟随"的判定。
 */
const props = withDefaults(defineProps<{ text: string; threshold?: number }>(), {
  threshold: 24,
});

const element = ref<HTMLElement>();
const following = ref(true);

function atBottom(el: HTMLElement) {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= props.threshold;
}

function follow() {
  const el = element.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function onScroll() {
  const el = element.value;
  if (el) following.value = atBottom(el);
}

// 增量按帧合并后到达,每次内容变化最多触发一次贴底,开销与帧数同级。
watch(
  () => props.text,
  async () => {
    if (!following.value) return;
    await nextTick();
    follow();
  },
  { flush: 'post' },
);

onMounted(() => {
  // 展开一段已经在输出的思考时,直接看最新内容。
  follow();
});
</script>

<template>
  <p
    ref="element"
    class="run-reasoning-text scrollbar-thin"
    aria-live="polite"
    @scroll.passive="onScroll"
  >{{ text }}</p>
</template>
