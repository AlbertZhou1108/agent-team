<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Copy, Check } from '@lucide/vue';
import { useClipboard } from '@vueuse/core';
import { api } from '@/shared/api/client';
import type { FilePreviewResult } from '@/shared/api/raw-types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionBlock } from '@/components/panel';
import MarkdownRenderer from '@/components/ai-elements/MarkdownRenderer.vue';

const open = defineModel<boolean>('open', { default: false });

const props = defineProps<{
  groupId: string;
  filePath: string;
}>();

const loading = ref(false);
const error = ref('');
const result = ref<FilePreviewResult | null>(null);
const rawMode = ref(false);
const { copy, copied } = useClipboard({ copiedDuring: 1500, legacy: true });

const isMarkdown = computed(() => /\.(?:md|markdown)$/i.test(result.value?.path ?? props.filePath));

async function load() {
  if (!open.value || !props.groupId || !props.filePath) return;
  loading.value = true;
  error.value = '';
  result.value = null;
  try {
    result.value = await api.previewTeamFile(props.groupId, props.filePath);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [open.value, props.groupId, props.filePath] as const,
  ([isOpen]) => {
    if (isOpen) {
      rawMode.value = false;
      void load();
    }
  },
  { immediate: true },
);
</script>

<template>
  <Dialog :open="open" @update:open="(value) => (open = value)">
    <DialogContent class="max-h-[82vh] max-w-2xl overflow-hidden flex flex-col" data-testid="file-preview-dialog">
      <DialogHeader>
        <DialogTitle class="flex flex-wrap items-center gap-2 pr-6">
          <span class="min-w-0 truncate font-mono text-sm">{{ result?.path ?? filePath }}</span>
          <Badge v-if="result" variant="outline" size="xs">
            {{ result.rootKind === 'worktree' ? `worktree · ${result.memberName ?? ''}` : '主工作区' }}
          </Badge>
          <Badge v-if="result?.truncated" variant="warning" size="xs">已截断（仅预览前 128 KB）</Badge>
        </DialogTitle>
        <DialogDescription>
          只读预览团队工作区或受管 worktree 内的文档；严格受限于当前团队目录边界。
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <Button type="button" variant="outline" size="xs" @click="copy(filePath)">
            <Check v-if="copied" class="size-3.5" />
            <Copy v-else class="size-3.5" />
            复制路径
          </Button>
          <Button
            v-if="result && isMarkdown"
            type="button"
            variant="ghost"
            size="xs"
            @click="rawMode = !rawMode"
          >
            {{ rawMode ? '渲染预览' : '源码原文' }}
          </Button>
        </div>
        <span v-if="result" class="text-xs text-muted-foreground tabular-nums">{{ result.size }} 字节</span>
      </div>

      <Alert v-if="error" variant="destructive" data-testid="file-preview-error">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div v-else-if="loading" class="py-8 text-center text-sm text-muted-foreground">正在读取文件…</div>

      <SectionBlock v-else-if="result" as="div" :container="false" tone="muted" size="sm" class="min-h-0 flex-1 overflow-auto p-3">
        <MarkdownRenderer v-if="isMarkdown && !rawMode" :content="result.content" />
        <pre v-else class="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-foreground">{{ result.content }}</pre>
      </SectionBlock>
    </DialogContent>
  </Dialog>
</template>
