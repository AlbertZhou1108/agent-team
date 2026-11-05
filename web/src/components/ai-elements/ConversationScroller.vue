<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui';
import { ScrollBar } from '@/components/ui/scroll-area';
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

defineSlots<{
  default?: () => unknown;
  /** 滚动区顶栏:sticky 会话操作区与随内容滚动的横幅。 */
  'bar-top'?: () => unknown;
  /** 滚动区底栏:sticky 输入区。 */
  'bar-bottom'?: () => unknown;
}>();

const viewport = ref<InstanceType<typeof ScrollAreaViewport>>();
const stream = computed(() => viewport.value?.viewportElement as HTMLElement | undefined);
const content = ref<HTMLElement>();
const barBottom = ref<HTMLElement>();
const barBottomHeight = ref(0);
const barTopHeight = ref(0);
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

// 回底按钮要悬浮在 sticky 底栏上沿。底栏是滚动列的直接子元素
// (sticky 的包含块约束:包一层等高 wrapper 会让它失去粘住余量),
// 实高从底栏 ref 测得;底栏不存在的只读视图记 0。底栏高度变化
// (成员状态卡展开/收起、输入区增高)由 observer 监听底栏自身捕获 ——
// 消息内容超屏时 content 高度不随底栏变化,只观察 content 会漏测。
// 顶栏实高同时用于缩短覆盖式滚动条轨道。
function measureBars() {
  const column = stream.value?.firstElementChild;
  const header = column?.querySelector<HTMLElement>(':scope > .conversation-header');
  barTopHeight.value = header?.offsetHeight ?? 0;
  barBottomHeight.value = barBottom.value?.offsetHeight ?? 0;
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
  measureBars();
  observer = new ResizeObserver(() => {
    measureBars();
    void revealLinkedInteraction();
    if (atBottom.value && !anchorPinned()) scrollToBottom();
    else updatePosition();
  });
  if (content.value) observer.observe(content.value);
  if (stream.value) observer.observe(stream.value);
  if (barBottom.value) observer.observe(barBottom.value);
  const header = stream.value?.querySelector('.conversation-header');
  if (header) observer.observe(header);
});

onBeforeUnmount(() => observer?.disconnect());

defineExpose({ scrollToBottom });
</script>

<template>
  <ScrollAreaRoot type="auto" :class="cn('relative min-h-0 overflow-hidden', viewportClass)">
    <ScrollAreaViewport
      ref="viewport"
      as-child
      role="log"
      aria-relevant="additions"
      :aria-label="ariaLabel"
      :class="cn('h-full min-h-0 [overflow-anchor:none]', streamClass)"
      @scroll="updatePosition"
    >
      <!-- 会话列:内容不足一屏时也撑满,底栏贴住帧底;内容超出后顶/底栏靠
           sticky 钉在滚动口沿,内容从栏下穿过(overlay 结构能力,材质只决定
           穿越是否可见)。滚动 padding 在 message-content 上,栏区零内边距。 -->
      <div class="flex min-h-full flex-col">
        <slot name="bar-top" />
        <div ref="content" class="min-w-0 flex-1" :class="contentClass">
          <slot />
        </div>
        <!-- sticky 载体必须是滚动列的直接子元素(包含块=整列才有粘住余量);
             槽内容(输入区组件)常自带根 wrapper,内层 sticky 会被它约束住。 -->
        <div ref="barBottom" class="conversation-bar-bottom shrink-0">
          <slot name="bar-bottom" />
        </div>
      </div>
    </ScrollAreaViewport>
    <!-- 覆盖式滚动条只占绘制层,不占布局宽度;轨道避开顶栏和输入区。 -->
    <ScrollBar class="z-30" :style="{ top: `${barTopHeight}px`, bottom: `${barBottomHeight}px`, height: 'auto' }" />
    <!-- 回底按钮锚在 viewport 层:底栏 sticky 钉在滚动口下沿,按钮按底栏实高
         (ResizeObserver 注入)悬浮其上,任何滚动位置都可见可点。 -->
    <Button
      v-if="!atBottom"
      class="jump-to-bottom animate-in fade-in-0 slide-in-from-bottom-2 duration-[var(--component-content-duration)]"
      :style="{ bottom: `${barBottomHeight + 12}px` }"
      variant="secondary"
      size="sm"
      :aria-label="hasNewMessages ? '有新消息，回到底部' : '回到底部'"
      title="回到底部"
      @click="scrollToBottom('smooth')"
    >
      <ArrowDown data-icon="inline-start" />{{ hasNewMessages ? '有新消息' : '回到底部' }}
    </Button>
  </ScrollAreaRoot>
</template>
