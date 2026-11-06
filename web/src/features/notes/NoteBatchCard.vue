<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  CircleDot,
  Trash2,
} from '@lucide/vue';
import { Card, CardContent } from '@/components/ui/card';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import type { NoteState } from '@/shared/api/raw-types';
import { NOTE_DRAG_TYPE } from '@/stores/note-handoff';
import { noteBatchActions, type NoteBatchAction } from './notes-state';

/**
 * 拖拽批量的投放卡片:拖起笔记时顶替详情页出现在同一个槽位里,
 * 每个动作一个投放区,悬停点亮、松手执行。负载(ids)来自 PDD 的
 * source.data,卡片自身不依赖选区状态。
 */
const props = defineProps<{ filter: NoteState }>();
const emit = defineEmits<{
  batch: [payload: { action: NoteBatchAction; ids: string[] }];
}>();

const actions = computed(() => noteBatchActions(props.filter));

const actionIcons: Record<NoteBatchAction, unknown> = {
  handoff: Archive,
  done: CheckCircle2,
  archived: Archive,
  active: CircleDot,
  restore: ArchiveRestore,
  remove: Trash2,
};

const toneClass = {
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  info: 'text-info',
  destructive: 'text-destructive',
} as const;

const hovered = ref<NoteBatchAction | null>(null);
const cleanups = new Map<NoteBatchAction, () => void>();

function bindZone(el: unknown, action: NoteBatchAction) {
  const spec = actions.value.find(item => item.key === action);
  if (el instanceof HTMLElement) {
    if (cleanups.has(action)) return;
    cleanups.set(
      action,
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => source.data.type === NOTE_DRAG_TYPE,
        getData: () => ({ type: 'note-drop-zone', action, tone: spec?.tone ?? 'primary' }),
        getDropEffect: () => 'move',
        onDragEnter: () => { hovered.value = action; },
        onDragLeave: () => { if (hovered.value === action) hovered.value = null; },
        onDrop: ({ source }) => {
          hovered.value = null;
          const ids = (source.data.ids as string[] | undefined) ?? [];
          if (!ids.length) return;
          emit('batch', { action, ids });
        },
      }),
    );
    return;
  }
  cleanups.get(action)?.();
  cleanups.delete(action);
}

onBeforeUnmount(() => {
  cleanups.forEach(cleanup => cleanup());
  cleanups.clear();
});
</script>

<template>
  <Card size="compact" class="notes-page-column notes-batch-pane min-w-0" data-testid="note-batch-card">
    <CardContent class="flex min-h-0 flex-col gap-4">
      <header class="flex flex-col gap-1">
        <h2 class="text-base font-semibold">批量操作</h2>
        <p class="text-xs text-muted-foreground">
          把拖着的笔记放到对应区域，松手即可执行。
        </p>
      </header>
      <div class="flex min-w-0 flex-col gap-2">
        <div
          v-for="action in actions"
          :key="action.key"
          :ref="el => bindZone(el, action.key)"
          class="note-batch-zone flex h-16 cursor-grab items-center gap-3 rounded-(--component-control-radius) border border-dashed px-4 text-sm"
          :class="toneClass[action.tone]"
          :data-batch-action="action.key"
          :data-drag-over="hovered === action.key ? 'true' : undefined"
        >
          <component :is="actionIcons[action.key]" class="size-4 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{{ action.label }}</span>
          <span v-if="hovered === action.key" class="shrink-0 text-xs">松开执行</span>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
