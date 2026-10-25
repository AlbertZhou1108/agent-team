<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowDown } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
let observer: ResizeObserver | undefined;

const route = useRoute();
let revealedInteraction: unknown;
async function revealLinkedInteraction() {
  const id = route.query.interaction;
  if (typeof id !== 'string' || revealedInteraction === id) return;
  await nextTick();
  requestAnimationFrame(() => {
    const element = document.getElementById(`interaction-${id}`);
    if (!element || !content.value?.contains(element)) return;
    revealedInteraction = id;
    atBottom.value = false;
    element.scrollIntoView({ block: 'center' });
    element.focus({ preventScroll: true });
  });
}
watch([() => route.query.interaction, () => props.ids], revealLinkedInteraction, { flush: 'post' });

function updatePosition() {
  const element = stream.value;
  if (!element) return;
  atBottom.value =
    element.scrollHeight - element.clientHeight - element.scrollTop <=
    props.threshold;
}

function scrollToBottom(behavior: ScrollBehavior = 'auto') {
  const element = stream.value;
  if (!element) return;
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
    // History insertion must take precedence over following the live tail.
    if (prepend) atBottom.value = false;
    await nextTick();
    if (prepend) {
      element.scrollTop = top + element.scrollHeight - height;
      updatePosition();
    } else if (follow) scrollToBottom();
    else updatePosition();
  },
  { flush: 'pre' },
);

watch(
  () => props.resetKey,
  async () => {
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
    if (atBottom.value) scrollToBottom();
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
      size="icon"
      aria-label="回到底部"
      title="回到底部"
      @click="scrollToBottom('smooth')"
    >
      <ArrowDown />
    </Button>
  </div>
</template>
