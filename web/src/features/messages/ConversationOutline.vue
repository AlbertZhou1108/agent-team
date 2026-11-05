<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { MessageView } from '@/shared/models/view-types';
import { prefersReducedMotion } from '@/shared/motion';
import {
  buildOutlineSegments,
  layoutOutlineBands,
  OUTLINE_BAND_PITCH,
  OUTLINE_MAX_BANDS,
  resolveCurrentSegment,
  type OutlineBand,
} from './outline-segments';

// 会话大纲只回答两件事:我在哪、我要回到哪。
// 一块 = 用户的一次提问,内部往返归到它前面的那一问里 —— 那一问就是这一块的标题。
const props = defineProps<{
  messages: MessageView[];
  /** 真实滚动元素(reka ScrollAreaViewport 的 viewportElement)。 */
  viewport?: HTMLElement;
}>();

/** 内容右缘要给轨道让出的宽度:消息头右侧的操作按钮不能被线盖住。 */
const RAIL_GUTTER = 24;

const segments = computed(() => buildOutlineSegments(props.messages));
// 等高块的排布是段数的纯函数:块数 = min(段数, 容量),轨道高 = 块数 × 格高。
// 段少时轨道抱住内容,段多时封顶在最大高度、粒度放粗 —— 不需要任何测量。
const bands = computed(() => layoutOutlineBands(segments.value, { maxBands: OUTLINE_MAX_BANDS }));
const railHeight = computed(() => bands.value.length * OUTLINE_BAND_PITCH);
const positioned = computed(() =>
  bands.value.map((band, index) => ({
    ...band,
    top: index * OUTLINE_BAND_PITCH,
    // 按钮铺满自己那一格,相邻块严丝合缝 —— 轨道上任何一处指针都归属于
    // 唯一一块,不存在点空的死区;视觉上的细线由内部填充自己画。
    size: OUTLINE_BAND_PITCH,
  })),
);

const currentId = ref<string | null>(null);
const rail = ref<HTMLElement>();
let resizeObserver: ResizeObserver | undefined;

function messageNode(id: string): HTMLElement | null {
  const element = props.viewport;
  return element?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`) ?? null;
}

// 判定的"视口顶"要避开 sticky 会话头:被它盖住的那条才算读者眼里的第一行。
function headerHeight(element: HTMLElement): number {
  return element.querySelector<HTMLElement>('.conversation-header')?.offsetHeight ?? 0;
}

/** 段序号 → 所属块。并组后多个段共用一块,当前段落到它就高亮整块。 */
const currentKey = computed(() => {
  const index = segments.value.findIndex(segment => segment.id === currentId.value);
  if (index < 0) return null;
  return bands.value.find(band => band.indexes.includes(index))?.id ?? null;
});

/**
 * 当前段只跟滚动位置有关;块的排布在上面是纯 computed,不在这里量。
 * 滚动事件里同步量:窗口被遮挡、标签页在后台时 requestAnimationFrame
 * 可能一直不触发,排进去就等于高亮永远停在滚动前的位置。
 */
function measure() {
  const element = props.viewport;
  if (!element || !segments.value.length) {
    currentId.value = null;
    return;
  }
  const elementRect = element.getBoundingClientRect();
  const scrollHeight = element.scrollHeight || 1;
  const anchors: Array<{ id: string; top: number }> = [];
  for (const segment of segments.value) {
    const node = messageNode(segment.id);
    if (!node) continue;
    anchors.push({ id: segment.id, top: node.getBoundingClientRect().top - elementRect.top });
  }
  if (!anchors.length) {
    currentId.value = null;
    return;
  }
  // 到底时直接给最后一块:否则最后一段太短时,高亮会停在前一块上。
  const atBottom = scrollHeight - element.clientHeight - element.scrollTop <= 24;
  currentId.value = atBottom
    ? anchors[anchors.length - 1]!.id
    : resolveCurrentSegment(anchors, headerHeight(element));
}

function onScroll() {
  measure();
}

function jump(band: OutlineBand) {
  const element = props.viewport;
  const node = messageNode(band.id);
  if (!element || !node) return;
  const top = node.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
  // 平滑滚过去,与「回到底部」按钮同一套行为;减少动效档直接到位。
  // 高亮不在这里手动指定:滚动事件会沿途逐段刷新当前段,高亮自然扫过去,
  // 终点恰好落在被点的块上 —— 手动指定反而会先跳到目标再扫回来。
  // 让目标停在会话头下沿,落点才和判定线是同一处。
  element.scrollTo({
    top: Math.max(0, top - headerHeight(element)),
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
}

function bandLabel(band: OutlineBand) {
  const total = segments.value.length;
  const first = segments.value[band.indexes[0]!];
  const last = segments.value[band.indexes[band.indexes.length - 1]!];
  if (!first || !last) return '';
  const range = band.indexes.length > 1
    ? `第 ${first.index + 1}–${last.index + 1} 段，共 ${total} 段`
    : `第 ${first.index + 1} 段，共 ${total} 段`;
  return `${range}：${first.title}`;
}

function bandPreview(band: OutlineBand) {
  return band.indexes.length > 1 ? `${band.title} · 合并 ${band.indexes.length} 段` : band.title;
}

// 内容右缘要给轨道让位,否则消息头右侧的「⋯」会被线盖住点不到。
// 轨道不渲染时归零,不相干的会话不该白白退掉一条内边距。
watch(
  () => [props.viewport, positioned.value.length] as const,
  ([element, count]) => {
    element?.style.setProperty('--outline-gutter', count ? `${RAIL_GUTTER}px` : '0px');
  },
  { immediate: true },
);

watch(
  () => props.viewport,
  (element, previous) => {
    previous?.removeEventListener('scroll', onScroll);
    element?.addEventListener('scroll', onScroll, { passive: true });
    resizeObserver?.disconnect();
    if (element) {
      // 内容高度变化(图片解码、展开全文、新消息)会移动锚点而不触发滚动,
      // 用 ResizeObserver 补一次当前段判定。
      resizeObserver = new ResizeObserver(measure);
      resizeObserver.observe(element);
      const content = element.querySelector<HTMLElement>('.message-content');
      if (content) resizeObserver.observe(content);
    }
    measure();
  },
  { immediate: true },
);

// 段集合变化:块的排布是 computed 自动跟上的,这里只需在新锚点挂载后重判当前段。
watch(segments, async () => {
  await nextTick();
  measure();
});

watch(() => props.messages.length, () => measure());

onMounted(() => {
  nextTick(measure);
});

onBeforeUnmount(() => {
  props.viewport?.removeEventListener('scroll', onScroll);
  props.viewport?.style.removeProperty('--outline-gutter');
  resizeObserver?.disconnect();
});
</script>

<template>
  <nav
    v-if="segments.length"
    class="conversation-outline"
    aria-label="会话大纲"
  >
    <div
      ref="rail"
      class="conversation-outline-rail"
      :style="{ blockSize: `${railHeight}px` }"
    >
      <button
        v-for="band in positioned"
        :key="band.id"
        type="button"
        class="conversation-outline-band"
        :data-current="band.id === currentKey ? 'true' : 'false'"
        :data-merged="band.indexes.length > 1 ? 'true' : 'false'"
        :style="{ top: `${band.top}px`, height: `${band.size}px` }"
        :aria-label="bandLabel(band)"
        :aria-current="band.id === currentKey ? 'location' : undefined"
        @click="jump(band)"
      >
        <span class="conversation-outline-fill" aria-hidden="true" />
        <span class="conversation-outline-preview" aria-hidden="true">{{ bandPreview(band) }}</span>
      </button>
    </div>
  </nav>
</template>
