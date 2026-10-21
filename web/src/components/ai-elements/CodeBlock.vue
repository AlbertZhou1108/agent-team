<script setup lang="ts">
import { Copy, Check } from '@lucide/vue';
import { ref } from 'vue';
import { Button } from '@/components/ui/button';

const props = withDefaults(defineProps<{
  code: string;
  language?: string;
  maxHeight?: string;
}>(), {
  language: 'json',
  maxHeight: '18rem',
});

const copied = ref(false);

async function copy() {
  await navigator.clipboard.writeText(props.code);
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1200);
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--code)]">
    <div class="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5">
      <span class="font-mono text-[10px] uppercase tracking-[0.16em] text-dim">{{ language }}</span>
      <Button variant="ghost" size="sm" class="h-6 px-2" @click="copy">
        <Check v-if="copied" :size="12" />
        <Copy v-else :size="12" />
        {{ copied ? '已复制' : '复制' }}
      </Button>
    </div>
    <pre
      class="max-h-72 overflow-auto p-3 font-mono text-[11px] leading-5 text-[var(--code-foreground)]"
    ><code>{{ code }}</code></pre>
  </div>
</template>
