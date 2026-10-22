<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Archive,
  Ban,
  Check,
  Clock3,
  GripVertical,
  ListOrdered,
  RotateCcw,
  ShieldAlert,
  Target,
  Trash2,
  Undo2,
  X,
} from '@lucide/vue';
import { toast } from 'vue-sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { api } from '@/shared/api/client';
import type { GoalState, GoalView } from '@/shared/api/raw-types';
import { useTeamGoalsQuery } from '@/features/queries';

const props = defineProps<{ teamId: string }>();
const query = useTeamGoalsQuery(() => props.teamId);
const data = computed(() => query.data.value);
const queue = ref<GoalView[]>([]);
const busy = ref(false);
const draggingId = ref<string>();
const dropTargetId = ref<string>();

watch(
  () => data.value?.queue,
  value => {
    if (draggingId.value) return;
    queue.value = [...(value ?? [])];
  },
  { immediate: true },
);

const stateLabels: Record<GoalState, string> = {
  queued: '排队中',
  active: '执行中',
  finalizing: '收尾中',
  completed: '已完成',
  terminated: '已终止',
  cancelled: '已取消',
};

function stateVariant(state: GoalState) {
  if (state === 'active') return 'success';
  if (state === 'finalizing') return 'warning';
  if (state === 'terminated' || state === 'cancelled') return 'danger';
  if (state === 'completed') return 'accent';
  return 'default';
}

function nextOperationId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `goal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function run(action: () => Promise<unknown>, message: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    await action();
    await query.refetch();
    toast.success(message);
  } catch (error) {
    toast.error('Goal 操作失败', { description: String(error) });
    await query.refetch();
  } finally {
    busy.value = false;
  }
}

function confirmDraft(draftId: string, draftRevision: number, hash: string) {
  if (!data.value || !window.confirm('确认这个 Goal Draft 并加入队列？')) return;
  void run(
    () => api.confirmGoalDraft(props.teamId, draftId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      draftRevision,
      hash,
    }),
    'Goal Draft 已确认',
  );
}

function deleteDraft(draftId: string, draftRevision: number) {
  if (!data.value || !window.confirm('删除这个 Goal Draft？')) return;
  void run(
    () => api.deleteGoalDraft(props.teamId, draftId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      draftRevision,
    }),
    'Goal Draft 已删除',
  );
}

function cancelGoal(goalId: string) {
  if (!data.value) return;
  const reason = window.prompt('取消这个排队 Goal 的原因');
  if (!reason?.trim()) return;
  void run(
    () => api.cancelQueuedGoal(props.teamId, goalId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      reason: reason.trim(),
    }),
    '排队 Goal 已取消',
  );
}

function withdrawFinish(goalId: string) {
  if (!data.value) return;
  const reason = window.prompt('撤回收尾的原因');
  if (!reason?.trim()) return;
  void run(
    () => api.withdrawGoalFinish(props.teamId, goalId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      reason: reason.trim(),
    }),
    '已撤回 Goal 收尾',
  );
}

function terminateCurrent(goalId: string) {
  if (!data.value || !window.confirm('终止当前 Goal？该操作不会删除 Team 历史。')) return;
  const reason = window.prompt('终止原因');
  if (!reason?.trim()) return;
  void run(
    () => api.terminateGoal(props.teamId, goalId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      reason: reason.trim(),
    }),
    'Current Goal 已终止',
  );
}

function archiveTeam() {
  if (!data.value || !window.confirm('归档这个 Team？归档后不再接受消息或启动 Goal。')) return;
  void run(
    () => api.archiveTeamGoals(props.teamId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
    }),
    'Team 已归档',
  );
}

function restoreTeam() {
  if (!data.value) return;
  void run(
    () => api.restoreTeamGoals(props.teamId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
    }),
    'Team 已恢复',
  );
}

function startDrag(goalId: string, event: DragEvent) {
  if (busy.value || data.value?.team.state === 'archived') {
    event.preventDefault();
    return;
  }
  draggingId.value = goalId;
  event.dataTransfer?.setData('application/x-agent-team-goal-id', goalId);
  event.dataTransfer?.setData('text/plain', goalId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function overGoal(goalId: string, event: DragEvent) {
  if (!draggingId.value || draggingId.value === goalId) return;
  event.preventDefault();
  dropTargetId.value = goalId;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}

function endDrag() {
  draggingId.value = undefined;
  dropTargetId.value = undefined;
}

function dropGoal(targetId: string) {
  const sourceId = draggingId.value;
  if (!sourceId || sourceId === targetId || !data.value) {
    endDrag();
    return;
  }
  const next = [...queue.value];
  const from = next.findIndex(goal => goal.id === sourceId);
  const to = next.findIndex(goal => goal.id === targetId);
  if (from < 0 || to < 0) {
    endDrag();
    return;
  }
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  queue.value = next;
  draggingId.value = undefined;
  dropTargetId.value = undefined;
  void run(
    () => api.reorderGoalQueue(props.teamId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      orderedGoalIds: next.map(goal => goal.id),
    }),
    'Goal 队列顺序已保存',
  );
}
</script>

<template>
  <div class="flex flex-col gap-5 p-1 text-sm">
    <p v-if="query.isPending.value" role="status">正在读取 Goal 状态…</p>
    <p v-else-if="query.error.value" role="alert">读取失败：{{ query.error.value.message }}</p>
    <template v-else-if="data">
      <section class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <Badge :variant="data.team.state === 'open' ? 'success' : 'warning'">
            {{ data.team.state === 'open' ? 'Team 开放' : 'Team 已归档' }}
          </Badge>
          <Badge>{{ data.current ? '有 Current Goal' : '无 Current Goal' }}</Badge>
          <Badge>{{ queue.length }} 个排队</Badge>
          <Badge>{{ data.drafts.length }} 个草稿</Badge>
        </div>
        <p class="text-xs text-muted-foreground">
          Team 与 Goal 独立运行；Goal 结束后 Team 仍可继续交流。
        </p>
        <div class="flex flex-wrap gap-2">
          <Button
            v-if="data.team.state === 'open' && !data.current"
            variant="outline"
            size="sm"
            :disabled="busy"
            @click="archiveTeam"
          >
            <Archive data-icon="inline-start" />
            归档 Team
          </Button>
          <Button
            v-if="data.team.state === 'archived'"
            variant="outline"
            size="sm"
            :disabled="busy"
            @click="restoreTeam"
          >
            <RotateCcw data-icon="inline-start" />
            恢复 Team
          </Button>
        </div>
      </section>

      <Separator />

      <section class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <Target :size="14" />
          <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">当前 Goal</h3>
        </div>
        <Empty v-if="!data.current" class="min-h-36 p-5">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Clock3 />
            </EmptyMedia>
            <EmptyTitle>当前没有执行目标</EmptyTitle>
            <EmptyDescription>Team 保持开放，可以继续普通交流或确认新的 Goal Draft。</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <div v-else class="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="accent">Goal #{{ data.current.number }}</Badge>
            <Badge :variant="stateVariant(data.current.state)">
              {{ stateLabels[data.current.state] }}
            </Badge>
            <Badge v-if="data.current.state === 'finalizing'">
              cutoff #{{ data.current.cutoffSeq }}
            </Badge>
          </div>
          <p class="whitespace-pre-wrap font-medium">
            {{ data.current.contract?.contract.goal }}
          </p>
          <p
            v-if="data.current.state === 'finalizing'"
            class="text-xs text-muted-foreground"
          >
            待消费 Goal Inbox：{{ data.current.unconsumedInboxCount ?? 0 }}
          </p>
          <ol class="flex list-decimal flex-col gap-1 pl-5 text-xs text-muted-foreground">
            <li
              v-for="criterion in data.current.contract?.contract.criteria ?? []"
              :key="criterion.id"
            >
              {{ criterion.text }}
            </li>
          </ol>
          <div class="flex flex-wrap gap-2">
            <Button
              v-if="data.current.state === 'finalizing'"
              variant="outline"
              size="sm"
              :disabled="busy"
              @click="withdrawFinish(data.current.id)"
            >
              <Undo2 data-icon="inline-start" />
              撤回收尾
            </Button>
            <Button
              variant="destructive"
              size="sm"
              :disabled="busy"
              @click="terminateCurrent(data.current.id)"
            >
              <Ban data-icon="inline-start" />
              终止 Goal
            </Button>
          </div>
        </div>
      </section>

      <Separator />

      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <ListOrdered :size="14" />
            <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">Goal 队列</h3>
          </div>
          <Badge>{{ queue.length }}</Badge>
        </div>
        <Empty v-if="!queue.length" class="min-h-28 p-5">
          <EmptyHeader>
            <EmptyTitle>队列为空</EmptyTitle>
            <EmptyDescription>确认 Goal Draft 后会进入这里。</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <div v-else class="flex flex-col gap-2">
          <article
            v-for="goal in queue"
            :key="goal.id"
            :draggable="data.team.state === 'open' && !busy"
            class="flex cursor-grab flex-col gap-2 rounded-lg border bg-background p-3 transition-[opacity,transform,border-color] duration-200 active:cursor-grabbing"
            :class="{
              'opacity-50': draggingId === goal.id,
              'border-primary': dropTargetId === goal.id,
            }"
            @dragstart="startDrag(goal.id, $event)"
            @dragover="overGoal(goal.id, $event)"
            @dragend="endDrag"
            @drop.prevent="dropGoal(goal.id)"
          >
            <div class="flex items-start gap-2">
              <GripVertical class="mt-0.5 shrink-0 text-muted-foreground" :size="14" />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <Badge>#{{ goal.number }}</Badge>
                  <Badge :variant="goal.eligibility?.eligible ? 'success' : 'warning'">
                    {{ goal.eligibility?.eligible ? '可启动' : '暂不可启动' }}
                  </Badge>
                </div>
                <p class="mt-2 line-clamp-3 whitespace-pre-wrap text-xs">
                  {{ goal.contract?.contract.goal }}
                </p>
              </div>
            </div>
            <div
              v-if="goal.eligibility?.blockers.length"
              class="flex flex-col gap-1 rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground"
            >
              <p
                v-for="blocker in goal.eligibility.blockers"
                :key="blocker.code"
                class="flex items-start gap-1"
              >
                <ShieldAlert class="mt-0.5 shrink-0" :size="12" />
                <span>{{ blocker.detail }}</span>
              </p>
            </div>
            <div class="flex justify-end">
              <Button
                variant="ghost"
                size="xs"
                :disabled="busy || data.team.state === 'archived'"
                @click="cancelGoal(goal.id)"
              >
                <X data-icon="inline-start" />
                取消
              </Button>
            </div>
          </article>
        </div>
      </section>

      <Separator />

      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">Goal Draft</h3>
          <Badge>{{ data.drafts.length }}</Badge>
        </div>
        <Empty v-if="!data.drafts.length" class="min-h-28 p-5">
          <EmptyHeader>
            <EmptyTitle>没有待确认草稿</EmptyTitle>
            <EmptyDescription>让 Main Agent 准备新的 Goal，草稿会出现在这里。</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <article
          v-for="draft in data.drafts"
          :key="draft.id"
          class="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3"
        >
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="warning">草稿</Badge>
            <Badge>revision {{ draft.revision }}</Badge>
            <Badge>{{ draft.body.contract.policy }}</Badge>
          </div>
          <p class="whitespace-pre-wrap font-medium">{{ draft.body.contract.goal }}</p>
          <ol class="flex list-decimal flex-col gap-1 pl-5 text-xs text-muted-foreground">
            <li
              v-for="criterion in draft.body.contract.criteria"
              :key="criterion.id"
            >
              {{ criterion.text }}
            </li>
          </ol>
          <p class="break-all font-mono text-[10px] text-muted-foreground">
            {{ draft.hash }}
          </p>
          <div class="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              :disabled="busy || data.team.state === 'archived'"
              @click="deleteDraft(draft.id, draft.revision)"
            >
              <Trash2 data-icon="inline-start" />
              删除
            </Button>
            <Button
              size="sm"
              :disabled="busy || data.team.state === 'archived'"
              @click="confirmDraft(draft.id, draft.revision, draft.hash)"
            >
              <Check data-icon="inline-start" />
              确认并排队
            </Button>
          </div>
        </article>
      </section>

      <template v-if="data.history.length">
        <Separator />
        <details class="text-xs">
          <summary class="cursor-pointer text-xs font-semibold tracking-wide text-muted-foreground">
            Goal 历史 · {{ data.history.length }}
          </summary>
          <div class="mt-3 flex flex-col gap-2">
            <div
              v-for="goal in data.history"
              :key="goal.id"
              class="flex items-start gap-2 rounded-md border p-2"
            >
              <Badge>#{{ goal.number }}</Badge>
              <span class="min-w-0 flex-1">{{ goal.contract?.contract.goal }}</span>
              <Badge :variant="stateVariant(goal.state)">
                {{ stateLabels[goal.state] }}
              </Badge>
            </div>
          </div>
        </details>
      </template>
    </template>
  </div>
</template>
