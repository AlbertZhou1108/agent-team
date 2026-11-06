import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue';

/**
 * 触底自动加载:哨兵进入可视区即触发 load,分页是数据层能力,列表里不出现按钮。
 * root 不传时以视口为参照;嵌套滚动容器(ScrollRegion 等)传容器元素。
 * 观察跟随哨兵本身——哨兵可能晚于组件出现;首屏没填满滚动容器时不会再有
 * 「进入视口」事件,所以每取完一页重新观察一次,按当前布局重判。
 */
export function useSentinelLoad(options: {
  sentinel: Ref<HTMLElement | null>;
  /** 嵌套滚动容器的元素;缺省用视口。 */
  root?: Ref<Element | null>;
  hasMore: () => boolean;
  loading?: () => boolean;
  load: () => void;
}) {
  let observer: IntersectionObserver | null = null;

  function observe() {
    observer?.disconnect();
    observer = null;
    const element = options.sentinel.value;
    if (!element) return;
    const root = options.root?.value ?? null;
    observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        if (!options.hasMore() || options.loading?.()) return;
        options.load();
      },
      // 提前一点开始取,滚到尽头时内容已经就位。
      { root: root ?? null, rootMargin: '120px' },
    );
    observer.observe(element);
  }

  onMounted(() => {
    watch([options.sentinel, options.root ?? null], () => observe(), { immediate: true });
  });

  // 取完一页重判:等布局落定(新内容已进 DOM)再重新观察,否则看到的还是旧位置。
  watch(
    [() => options.hasMore(), () => options.loading?.() ?? false],
    async ([more, loading]) => {
      if (!more || loading || !observer) return;
      await nextTick();
      observe();
    },
  );

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });
}
