<script setup lang="ts">
import { Copy, Check } from '@lucide/vue';
import { ref } from 'vue';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardAction,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const props = withDefaults(
  defineProps<{
    code: string;
    language?: string;
    maxHeight?: string;
  }>(),
  {
    language: 'json',
    maxHeight: '18rem',
  },
);

const copied = ref(false);

async function copy() {
  await navigator.clipboard.writeText(props.code);
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1200);
}
</script>

<template>
  <Card class="overflow-hidden">
    <CardHeader>
      <CardTitle>{{ language }}</CardTitle>
      <CardAction>
        <Button variant="ghost" size="sm" @click="copy">
          <Check v-if="copied" />
          <Copy v-else />
          {{ copied ? '已复制' : '复制' }}
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent>
      <pre
        class="overflow-auto font-mono text-sm"
        :style="{ maxHeight }"
      ><code>{{ code }}</code></pre>
    </CardContent>
  </Card>
</template>
