<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowDown } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/shared/motion';

const props = withDefaults(
  defineProps<{
    ids: Array<string | number>;
    resetKey?: string | number;
    viewportClass?: string;
    streamClass?: string;
    contentClass?: string;
    threshold?: number;
    ariaLabel?: string;
  }>(),
  {
    resetKey: undefined,
    viewportClass: '',
    streamClass: '',
    contentClass: '',
    threshold: 24,
    ariaLabel: '会话消息',
  },
);

const stream = ref<HTMLElement>();
const content = ref<HTMLElement>();
const atBottom = ref(true);
const hasNewMessages = ref(false);
let observer: ResizeObserver | undefined;

const route = useRoute();
let revealedInteraction: unknown;
// 定位纪元:锚点滚动每执行一次自增;翻页补偿用它发现"等待期间定位已接管"。
let revealSequence = 0;
function anchorId() {
  const id = route.query.interaction ?? route.query.message;
  return typeof id === 'string' ? id : null;
}
// 锚点定位完成后进入"锚点模式":URL 参数存在期间禁用自动跟底,
// 防止加载后期的补偿/跟底把视图拽回底部(用户手动滚到底后由常规滚动自然接管)。
function anchorPinned() {
  const id = anchorId();
  return id !== null && revealedInteraction === id;
}
async function revealLinkedInteraction() {
  const id = anchorId();
  if (!id || revealedInteraction === id) return;
  await nextTick();
  requestAnimationFrame(() => {
    const element = route.query.interaction
      ? document.getElementById(`interaction-${id}`)
      : content.value?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!element || !content.value?.contains(element)) return;
    revealedInteraction = id;
    revealSequence += 1;
    atBottom.value = false;
    element.scrollIntoView({ block: 'center' });
    element.focus({ preventScroll: true });
  });
}
watch([() => route.query.interaction, () => route.query.message, () => props.ids], revealLinkedInteraction, { flush: 'post' });

function updatePosition() {
  const element = stream.value;
  if (!element) return;
  atBottom.value =
    element.scrollHeight - element.clientHeight - element.scrollTop <=
    props.threshold;
  if (atBottom.value) hasNewMessages.value = false;
}

function scrollToBottom(behavior: ScrollBehavior = 'auto') {
  const element = stream.value;
  if (!element) return;
  if (prefersReducedMotion()) behavior = 'auto';
  element.scrollTo({ top: element.scrollHeight, behavior });
  updatePosition();
}

watch(
  () => props.ids.map(String),
  async (ids, previous) => {
    const element = stream.value;
    if (!element) return;
    const prepend = previous.length > 0 && ids.indexOf(previous[0]!) > 0;
    const top = element.scrollTop;
    const height = element.scrollHeight;
    const follow = atBottom.value;
    if (!follow && !prepend && ids.some(id => !previous.includes(id))) hasNewMessages.value = true;
    const sequence = revealSequence;
    if (prepend) atBottom.value = false;
    await nextTick();
    if (revealSequence !== sequence) {
      // 锚点定位在等待期间接管了滚动,放弃用旧位置补偿,避免覆盖定位结果。
      updatePosition();
      return;
    }
    if (prepend) {
      element.scrollTop = top + element.scrollHeight - height;
      updatePosition();
    } else if (follow && !anchorPinned()) {
      scrollToBottom();
    } else {
      updatePosition();
    }
  },
  { flush: 'pre' },
);

watch(
  () => props.resetKey,
  async () => {
    hasNewMessages.value = false;
    atBottom.value = true;
    await nextTick();
    scrollToBottom();
  },
);

onMounted(() => {
  scrollToBottom();
  void revealLinkedInteraction();
  observer = new ResizeObserver(() => {
    void revealLinkedInteraction();
    if (atBottom.value && !anchorPinned()) scrollToBottom();
    else updatePosition();
  });
  if (content.value) observer.observe(content.value);
  if (stream.value) observer.observe(stream.value);
});

onBeforeUnmount(() => observer?.disconnect());

defineExpose({ scrollToBottom });
</script>

<template>
  <div :class="cn('relative min-h-0', viewportClass)">
    <div
      ref="stream"
      role="log"
      aria-relevant="additions"
      :aria-label="ariaLabel"
      :class="cn('min-h-0 [overflow-anchor:none]', streamClass)"
      @scroll="updatePosition"
    >
      <div ref="content" :class="contentClass">
        <slot />
      </div>
    </div>
    <Button
      v-if="!atBottom"
      class="jump-to-bottom"
      variant="secondary"
      size="sm"
      :aria-label="hasNewMessages ? '有新消息，回到底部' : '回到底部'"
      title="回到底部"
      @click="scrollToBottom('smooth')"
    >
      <ArrowDown data-icon="inline-start" />{{ hasNewMessages ? '有新消息' : '回到底部' }}
    </Button>
  </div>
</template>
