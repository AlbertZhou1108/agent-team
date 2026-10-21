<script setup lang="ts">
import {
  ChevronsLeft,
  ChevronsRight,
  Settings2,
} from '@lucide/vue';
import type { Group } from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { useUiStore } from '@/stores/ui';
import { useConnectionStore } from '@/stores/connection';
import { cn } from '@/lib/utils';

defineProps<{
  groups: Group[];
  currentGroupId?: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  openSettings: [];
}>();

const ui = useUiStore();
const connection = useConnectionStore();
</script>

<template>
  <aside
    :class="cn(
      'group-sidebar',
      ui.sidebarCollapsed && 'group-sidebar-collapsed',
    )"
  >
    <div class="flex min-w-0 items-center gap-3 px-2">
      <span class="grid size-9 shrink-0 place-items-center rounded-xl border border-[var(--primary-border)] bg-[var(--primary-muted)] text-lg text-[var(--primary)]">◈</span>
      <div v-if="!ui.sidebarCollapsed" class="min-w-0">
        <p class="truncate text-sm font-semibold tracking-tight">Agent Team</p>
        <p class="truncate text-[10px] tracking-[0.14em] text-dim">LOCAL OBSERVATORY</p>
      </div>
    </div>

    <div v-if="!ui.sidebarCollapsed" class="mt-7 flex items-center justify-between px-2">
      <span class="eyebrow">群</span>
      <span class="font-mono text-[10px] text-dim">{{ groups.length }}</span>
    </div>

    <nav class="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
      <button
        v-for="group in groups"
        :key="group.id"
        type="button"
        :title="group.name"
        :class="cn('group-nav-item', group.id === currentGroupId && 'group-nav-item-active')"
        @click="emit('select', group.id)"
      >
        <span class="grid size-7 shrink-0 place-items-center rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] font-mono text-[10px]">
          {{ group.name.slice(0, 1) }}
        </span>
        <span v-if="!ui.sidebarCollapsed" class="min-w-0 flex-1">
          <span class="block truncate text-left text-xs font-medium">{{ group.name }}</span>
          <span class="mt-0.5 block truncate text-left font-mono text-[9px] text-dim">{{ group.id }}</span>
        </span>
      </button>
      <p v-if="!groups.length && !ui.sidebarCollapsed" class="px-3 py-4 text-xs leading-6 text-muted">
        还没有群。先在 CLI 中创建群。
      </p>
    </nav>

    <div v-if="!ui.sidebarCollapsed" class="mt-5 space-y-3 border-t border-[var(--border)] pt-4">
      <div class="flex items-center gap-2 px-2 text-[10px]">
        <span :class="['status-dot', connection.status === 'online' ? 'status-online' : connection.status === 'error' ? 'status-error' : 'status-connecting']" />
        <span class="min-w-0 flex-1 truncate text-muted">
          {{ connection.status === 'online' ? '本机已连接' : connection.status === 'error' ? '连接异常' : '正在连接' }}
        </span>
        <span v-if="connection.lastSyncedAt" class="font-mono text-dim">
          {{ connection.lastSyncedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}
        </span>
      </div>
    </div>

    <Button
      variant="ghost"
      size="sm"
      class="mt-3 justify-start px-2 text-muted"
      :title="ui.sidebarCollapsed ? '设置' : '打开设置'"
      @click="emit('openSettings')"
    >
      <Settings2 :size="15" />
      <span v-if="!ui.sidebarCollapsed">设置</span>
    </Button>

    <Button
      variant="ghost"
      size="sm"
      class="mt-3 justify-start px-2 text-dim"
      :title="ui.sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
      @click="ui.toggleSidebar()"
    >
      <ChevronsRight v-if="ui.sidebarCollapsed" :size="15" />
      <ChevronsLeft v-else :size="15" />
      <span v-if="!ui.sidebarCollapsed">收起</span>
    </Button>
  </aside>
</template>
