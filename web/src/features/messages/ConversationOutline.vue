<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { MessageView } from '@/shared/models/view-types';
import {
  buildOutlineSegments,
  resolveCurrentSegment,
  type OutlineAnchor,
} from './outline-segments';

// 会话大纲只回答两件事:我在哪、我要回到哪。
// 刻度是用户的提问,内部往返归到它前面的那一问里 —— 那一问就是这一段的标题。
const props = defineProps<{
  messages: MessageView[];
  /** 真实滚动元素(reka ScrollAreaViewport 的 viewportElement)。 */
  viewport?: HTMLElement;
}>();

const segments = computed(() => buildOutlineSegments(props.messages));
const currentId = ref<string | null>(null);
let frame = 0;

function messageNode(id: string): HTMLElement | null {
  const element = props.viewport;
  return element?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`) ?? null;
}

// 判定的"视口顶"要避开 sticky 会话头:被它盖住的那条才算读者眼里的第一行。
function headerHeight(element: HTMLElement): number {
  return element.querySelector<HTMLElement>('.conversation-header')?.offsetHeight ?? 0;
}

// 直接量锚点:实测 50 个锚点一次 0.1ms,不值得为它做缓存与失效管理。
function measure() {
  frame = 0;
  const element = props.viewport;
  if (!element || !segments.value.length) return;
  const base = element.getBoundingClientRect().top;
  const anchors: OutlineAnchor[] = [];
  for (const segment of segments.value) {
    const node = messageNode(segment.id);
    if (node) anchors.push({ id: segment.id, top: node.getBoundingClientRect().top - base });
  }
  // 到底时直接给最后一根:否则最后一段太短时,高亮会停在前一根上。
  const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
  const next = atBottom && anchors.length
    ? anchors[anchors.length - 1]!.id
    : resolveCurrentSegment(anchors, headerHeight(element));
  if (next !== currentId.value) currentId.value = next;
}

function onScroll() {
  if (frame) return;
  frame = requestAnimationFrame(measure);
}

function jump(id: string) {
  const element = props.viewport;
  const node = messageNode(id);
  if (!element || !node) return;
  const top = node.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
  // 瞬时到位:跳转的目的是到达,不播平滑滚动,也就没有"高亮一路扫过去"的问题。
  // 让目标停在会话头下沿,落点才和判定线是同一处。
  element.scrollTo({ top: Math.max(0, top - headerHeight(element)) });
  currentId.value = id;
}

watch(
  () => props.viewport,
  (element, previous) => {
    previous?.removeEventListener('scroll', onScroll);
    element?.addEventListener('scroll', onScroll, { passive: true });
    measure();
  },
  { immediate: true },
);

watch(segments, () => { requestAnimationFrame(measure); });

onBeforeUnmount(() => {
  props.viewport?.removeEventListener('scroll', onScroll);
  if (frame) cancelAnimationFrame(frame);
});
</script>

<template>
  <nav v-if="segments.length" class="conversation-outline" aria-label="会话大纲">
    <button
      v-for="segment in segments"
      :key="segment.id"
      type="button"
      class="conversation-outline-tick"
      :data-current="segment.id === currentId ? 'true' : 'false'"
      :aria-current="segment.id === currentId ? 'location' : undefined"
      :aria-label="`第 ${segment.index + 1} 段，共 ${segments.length} 段：${segment.title}`"
      @click="jump(segment.id)"
    >
      <span class="conversation-outline-preview" aria-hidden="true">{{ segment.title }}</span>
    </button>
  </nav>
</template>
