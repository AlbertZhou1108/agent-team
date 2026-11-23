<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Copy, Check, GitBranch, RefreshCw } from '@lucide/vue';
import { useClipboard } from '@vueuse/core';
import { toast } from 'vue-sonner';
import { api, ApiError } from '@/shared/api/client';
import type { Member, MemberWorktreeStatus, WorktreeRemoveResult } from '@/shared/api/raw-types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionBlock } from '@/components/panel';

const open = defineModel<boolean>('open', { default: false });

const props = defineProps<{
  groupId: string;
  member: Member | null;
  status?: MemberWorktreeStatus | null;
  running?: boolean;
}>();

const emit = defineEmits<{
  updated: [];
}>();

const busy = ref(false);
const refreshing = ref(false);
const actionError = ref('');
const retainedNotice = ref<WorktreeRemoveResult | null>(null);
const liveStatus = ref<MemberWorktreeStatus | null>(null);
const { copy, copied } = useClipboard({ copiedDuring: 1500, legacy: true });

const currentStatus = computed(() => liveStatus.value ?? props.status ?? null);
const unsavedCount = computed(() => {
  const s = currentStatus.value;
  if (!s) return 0;
  return s.dirtyCount + s.untrackedCount + s.aheadCount;
});

async function refreshStatus() {
  if (!props.groupId || !props.member || refreshing.value) return;
  refreshing.value = true;
  actionError.value = '';
  try {
    const rows = await api.teamWorktrees(props.groupId);
    liveStatus.value = rows.find((item) => item.memberId === props.member?.id) ?? null;
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    refreshing.value = false;
  }
}

watch(
  () => [open.value, props.member?.id] as const,
  ([isOpen]) => {
    if (!isOpen) return;
    actionError.value = '';
    retainedNotice.value = null;
    liveStatus.value = props.status ?? null;
    void refreshStatus();
  },
  { immediate: true },
);

async function mergeBranch() {
  if (!props.member || busy.value || props.running) return;
  busy.value = true;
  actionError.value = '';
  try {
    const res = await api.mergeMemberWorktree(props.groupId, props.member.id);
    if (res.alreadyUpToDate) {
      toast.info(`${res.branch} 没有领先主工作区的新提交`);
    } else {
      toast.success(`已合入 ${res.branch}（提交 ${res.commit ?? ''}）`);
    }
    emit('updated');
    await refreshStatus();
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

async function removeWorktree(force = false) {
  if (!props.member || busy.value || props.running) return;
  busy.value = true;
  actionError.value = '';
  try {
    const res = await api.removeMemberWorktree(props.groupId, props.member.id, force);
    if (res.retained) {
      retainedNotice.value = res;
      return;
    }
    toast.success(`已清理 ${props.member.name} 的 worktree，并切回共享主工作区`);
    emit('updated');
    open.value = false;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) {
      await refreshStatus();
      retainedNotice.value = {
        memberId: props.member.id,
        memberName: props.member.name,
        removed: false,
        retained: true,
        path: currentStatus.value?.path ?? props.member.worktree_path ?? null,
        branch: currentStatus.value?.branch ?? props.member.worktree_branch ?? null,
        dirtyCount: currentStatus.value?.dirtyCount ?? 0,
        untrackedCount: currentStatus.value?.untrackedCount ?? 0,
        aheadCount: currentStatus.value?.aheadCount ?? 0,
        reason: cause.message,
      };
      return;
    }
    actionError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(value) => (open = value)">
    <DialogContent v-if="member" class="max-w-lg" data-testid="member-worktree-dialog">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <GitBranch class="size-4 text-muted-foreground" />
          成员独立工作区 · {{ member.name }}
        </DialogTitle>
        <DialogDescription>
          独立 git worktree 防止并发写作者互相覆盖；合入要求成员已提交分支改动且主工作区干净。
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <Alert v-if="actionError" variant="destructive" data-testid="worktree-error">
          <AlertDescription>{{ actionError }}</AlertDescription>
        </Alert>

        <SectionBlock as="div" :container="false" tone="muted" size="sm" class="gap-2 p-3 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="font-medium text-foreground">分支：<span class="font-mono">{{ currentStatus?.branch ?? member.worktree_branch ?? '未知' }}</span></span>
            <Button type="button" variant="ghost" size="xs" :disabled="refreshing" @click="refreshStatus">
              <RefreshCw :class="['size-3.5', refreshing && 'animate-spin']" />
              刷新状态
            </Button>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="min-w-0 break-all font-mono text-muted-foreground">{{ currentStatus?.path ?? member.worktree_path ?? '—' }}</span>
            <Button
              v-if="currentStatus?.path || member.worktree_path"
              type="button"
              variant="ghost"
              size="xs"
              @click="copy(currentStatus?.path ?? member.worktree_path ?? '')"
            >
              <Check v-if="copied" class="size-3.5" />
              <Copy v-else class="size-3.5" />
            </Button>
          </div>
          <div v-if="currentStatus" class="flex flex-wrap gap-1.5 pt-1">
            <Badge v-if="!currentStatus.exists" variant="warning" size="xs">目录缺失</Badge>
            <Badge v-else variant="success" size="xs">目录正常</Badge>
            <Badge v-if="currentStatus.aheadCount > 0" variant="secondary" size="xs">未合入 {{ currentStatus.aheadCount }} 提交</Badge>
            <Badge v-if="currentStatus.dirtyCount + currentStatus.untrackedCount > 0" variant="warning" size="xs">
              未提交 {{ currentStatus.dirtyCount + currentStatus.untrackedCount }} 项
            </Badge>
            <Badge v-if="currentStatus.exists && unsavedCount === 0" variant="outline" size="xs">工作树干净</Badge>
          </div>
          <pre
            v-if="currentStatus?.diffStat"
            class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground"
          >{{ currentStatus.diffStat }}</pre>
          <p v-else-if="currentStatus?.changedFiles?.length" class="text-muted-foreground">
            未提交文件：{{ currentStatus.changedFiles.join(', ') }}
          </p>
        </SectionBlock>

        <Alert v-if="retainedNotice" variant="destructive" data-testid="worktree-retained-warning">
          <AlertDescription class="flex flex-col gap-2">
            <span>{{ retainedNotice.reason }}</span>
            <div class="flex justify-end">
              <Button
                type="button"
                variant="destructive"
                size="xs"
                :disabled="busy || running"
                data-testid="worktree-force-remove"
                @click="removeWorktree(true)"
              >
                确认强制删除（可能丢失代码）
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>

      <DialogFooter class="flex flex-wrap items-center justify-between gap-2 sm:justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="busy || running"
          data-testid="worktree-remove-btn"
          @click="removeWorktree(false)"
        >
          清理并切回共享工作区
        </Button>
        <div class="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" :disabled="busy" @click="open = false">关闭</Button>
          <Button
            type="button"
            size="sm"
            :disabled="busy || running || !currentStatus?.exists || currentStatus.dirtyCount + currentStatus.untrackedCount > 0"
            data-testid="worktree-merge-btn"
            @click="mergeBranch"
          >
            {{ busy ? '处理中…' : '合入主工作区' }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
