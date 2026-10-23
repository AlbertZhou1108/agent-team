<script setup lang="ts">
import { computed } from 'vue';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const props = defineProps<{
  content: string;
}>();

const markdown = new Marked({
  breaks: true,
  gfm: true,
});
const html = computed(() => (
  DOMPurify.sanitize(markdown.parse(props.content) as string)
));
</script>

<template>
  <div class="markdown-content min-w-0 max-w-full overflow-x-auto" v-html="html" />
</template>
