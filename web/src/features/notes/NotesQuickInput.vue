<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/shared/api/client';

/**
 * 随心记的快捷输入:right-popover 挂载的内容组件。
 * 只做「记一笔」这一件事 —— 写下正文就落库,完整整理在随心记页面里做。
 */
const props = defineProps<{ groupId?: string }>();

const client = useQueryClient();
const body = ref('');
const busy = ref(false);
const canSave = computed(() => body.value.trim().length > 0);

async function refresh() {
  // 与 NotesWorkspace 同一套失效谓词:列表与单条都可能是缓存起点。
  await Promise.all([
    client.invalidateQueries({ predicate: query => String(query.queryKey[0]) === 'notes' }),
    client.invalidateQueries({ predicate: query => String(query.queryKey[0]) === 'note' }),
  ]);
}

async function save() {
  const text = body.value.trim();
  if (!text || busy.value) return;
  busy.value = true;
  try {
    await api.createNote({ id: crypto.randomUUID(), body: text });
    body.value = '';
    await refresh();
    toast.success('已记下来');
  } catch (cause) {
    toast.error('记笔记失败', { description: String(cause) });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2" :data-attached-group="props.groupId ? 'true' : undefined">
    <Textarea
      v-model="body"
      class="min-h-24 bg-background"
      placeholder="想到什么就写下来……"
      aria-label="快速记一笔"
      @keydown.enter.exact.prevent="save"
    />
    <div class="flex items-center justify-between gap-2">
      <p class="text-xs text-muted-foreground">Enter 保存,完整整理去随心记页面。</p>
      <Button size="sm" :disabled="!canSave || busy" @click="save">
        <LoaderCircle v-if="busy" class="animate-spin" />
        记下来
      </Button>
    </div>
  </div>
</template>
