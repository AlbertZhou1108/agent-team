<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { resultLink, type ResultScope } from '@/shared/result-links';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const props = defineProps<{
  content: string;
  /** 流式输出期间节流:解析成本随全文长度线性增长,不必每个增量都整篇重来。 */
  defer?: boolean;
}>();

const markdown = new Marked({
  breaks: true,
  gfm: true,
});
const scope = inject<Ref<ResultScope | null>>('result-scope', computed(() => null));
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
markdown.use({ renderer: { link({ href, tokens }) {
  const target = resultLink(href, scope.value);
  return `<a href="${escape(target)}">${this.parser.parseInline(tokens)}</a>`;
} } });
const STREAM_PARSE_INTERVAL_MS = 120;

const html = ref('');
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let lastParsedAt = 0;

function parse(content: string) {
  lastParsedAt = Date.now();
  html.value = DOMPurify.sanitize(markdown.parse(content) as string);
}

function clearPending() {
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer);
    pendingTimer = undefined;
  }
}

function schedule() {
  if (!props.defer) {
    clearPending();
    parse(props.content);
    return;
  }
  const wait = STREAM_PARSE_INTERVAL_MS - (Date.now() - lastParsedAt);
  if (wait <= 0) {
    // 已经排队的那次会读到最新 content,这里只补一次立即解析。
    clearPending();
    parse(props.content);
    return;
  }
  // 保持单次排队即可:定时器触发时读取的是最新 props.content。
  if (pendingTimer === undefined) {
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      parse(props.content);
    }, wait);
  }
}

watch([() => props.content, () => props.defer, () => scope.value], schedule, { immediate: true });
onBeforeUnmount(clearPending);
</script>

<template>
  <div class="markdown-content min-w-0 max-w-full overflow-x-auto" v-html="html" />
</template>
