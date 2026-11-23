<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import {
  fileRefBasename,
  fileRefDisplayLabel,
  filePreviewContext,
  normalizeFilePathRef,
  splitBareFileRefs,
} from '@/features/messages/file-refs';
import { resultLink, type ResultScope } from '@/shared/result-links';
import { stabilizeStreamingMarkdown } from './streaming-markdown';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const props = defineProps<{
  content: string;
  /** 流式输出期间节流:解析成本随全文长度线性增长,不必每个增量都整篇重来。 */
  defer?: boolean;
}>();

const filePreview = inject(filePreviewContext, null);
const scope = inject<Ref<ResultScope | null>>('result-scope', computed(() => null));
const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderInlineFileChip(label: string, path: string): string {
  const safePath = escape(path);
  const safeLabel = escape(label);
  return `<button type="button" class="inline-file-chip" data-file-ref="${safePath}" title="预览 ${safePath}"><span class="inline-file-chip-icon" aria-hidden="true"></span><span>${safeLabel}</span></button>`;
}

const markdown = new Marked({
  breaks: true,
  gfm: true,
});
markdown.use({
  renderer: {
    link({ href, text, tokens }) {
      const refPath = filePreview ? normalizeFilePathRef(href) : null;
      if (refPath) {
        return renderInlineFileChip(fileRefDisplayLabel(text, refPath), refPath);
      }
      const target = resultLink(href, scope.value);
      return `<a href="${escape(target)}">${this.parser.parseInline(tokens)}</a>`;
    },
    codespan({ text }) {
      if (!filePreview || /\s/.test(text.trim())) return false;
      const refPath = normalizeFilePathRef(text);
      if (!refPath) return false;
      return renderInlineFileChip(fileRefBasename(refPath), refPath);
    },
    text(token) {
      if (!filePreview) return false;
      if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
      const segments = splitBareFileRefs(token.text);
      if (!segments.some((segment) => segment.type === 'file')) return false;
      const isEscaped = 'escaped' in token && Boolean(token.escaped);
      return segments
        .map((segment) => {
          if (segment.type === 'file') {
            return renderInlineFileChip(segment.label, segment.path);
          }
          return isEscaped ? segment.text : escape(segment.text);
        })
        .join('');
    },
  },
});
const STREAM_PARSE_INTERVAL_MS = 120;

const html = ref('');
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let lastParsedAt = 0;

function parse(content: string) {
  lastParsedAt = Date.now();
  const source = props.defer ? stabilizeStreamingMarkdown(content) : content;
  html.value = DOMPurify.sanitize(markdown.parse(source) as string, {
    ADD_ATTR: ['data-file-ref'],
  });
}

function handleClick(event: MouseEvent) {
  if (!filePreview) return;
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-file-ref]');
  const refPath = target?.dataset.fileRef;
  if (!refPath) return;
  event.preventDefault();
  filePreview.open(refPath);
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
  <div class="markdown-content min-w-0 max-w-full overflow-x-auto" @click="handleClick" v-html="html" />
</template>
