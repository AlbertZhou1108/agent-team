<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Ban,
  Check,
  ChevronsUpDown,
  Clock3,
  GripVertical,
  ListOrdered,
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
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
const currentOpen = ref(false);
const queueOpen = ref(false);
const draftsOpen = ref(false);
const historyOpen = ref(false);

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
const policyLabels: Record<string, string> = {
  communication: '仅沟通',
  'read-only': '只读',
  'workspace-write': '允许修改',
};

watch(
  () => data.value?.current?.id,
  id => {
    currentOpen.value = Boolean(id);
  },
  { immediate: true },
);
watch(
  () => data.value?.queue.length ?? 0,
  count => {
    queueOpen.value = count > 0;
  },
  { immediate: true },
);
watch(
  () => data.value?.drafts.length ?? 0,
  count => {
    draftsOpen.value = count > 0;
  },
  { immediate: true },
);
watch(
  () => data.value?.history.length ?? 0,
  count => {
    historyOpen.value = count > 0;
  },
  { immediate: true },
);

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
    toast.error('任务操作失败', { description: String(error) });
    await query.refetch();
  } finally {
    busy.value = false;
  }
}

function confirmDraft(draftId: string, draftRevision: number, hash: string) {
  if (!data.value || !window.confirm('确认这个任务草稿并加入队列？')) return;
  void run(
    () => api.confirmGoalDraft(props.teamId, draftId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      draftRevision,
      hash,
    }),
    '任务草稿已确认',
  );
}

function deleteDraft(draftId: string, draftRevision: number) {
  if (!data.value || !window.confirm('删除这个任务草稿？')) return;
  void run(
    () => api.deleteGoalDraft(props.teamId, draftId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      draftRevision,
    }),
    '任务草稿已删除',
  );
}

function cancelGoal(goalId: string) {
  if (!data.value) return;
  const reason = window.prompt('取消这个排队任务的原因');
  if (!reason?.trim()) return;
  void run(
    () => api.cancelQueuedGoal(props.teamId, goalId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      reason: reason.trim(),
    }),
    '排队任务已取消',
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
    '已撤回任务收尾',
  );
}

function terminateCurrent(goalId: string) {
  if (!data.value || !window.confirm('终止当前任务？该操作不会删除团队历史。')) return;
  const reason = window.prompt('终止原因');
  if (!reason?.trim()) return;
  void run(
    () => api.terminateGoal(props.teamId, goalId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      reason: reason.trim(),
    }),
    '当前任务已终止',
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
    '任务队列顺序已保存',
  );
}
</script>

<template>
  <div class="flex flex-col gap-5 p-1 text-sm">
    <p v-if="query.isPending.value" role="status">正在读取任务状态…</p>
    <p v-else-if="query.error.value" role="alert">读取失败：{{ query.error.value.message }}</p>
    <template v-else-if="data">
      <div class="flex flex-wrap items-center gap-2">
        <Badge>{{ data.current ? `当前任务 #${data.current.number}` : '无当前任务' }}</Badge>
        <Badge>{{ queue.length }} 个排队</Badge>
        <Badge>{{ data.drafts.length }} 个草稿</Badge>
      </div>

      <Collapsible v-model:open="currentOpen" class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <Target :size="14" />
            <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">当前任务</h3>
          </div>
          <div class="flex items-center gap-2">
            <Badge v-if="data.current" :variant="stateVariant(data.current.state)">
              {{ stateLabels[data.current.state] }}
            </Badge>
            <CollapsibleTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                class="size-8"
              >
                <ChevronsUpDown />
                <span class="sr-only">{{ currentOpen ? '收起当前任务' : '展开当前任务' }}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <Empty v-if="!data.current" class="min-h-28 p-5">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3 />
              </EmptyMedia>
              <EmptyTitle>无当前任务</EmptyTitle>
              <EmptyDescription>可以继续普通交流，或等待新的任务草稿。</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <div v-else class="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <Badge variant="accent">任务 #{{ data.current.number }}</Badge>
              <Badge v-if="data.current.state === 'finalizing'">
                收尾截止 #{{ data.current.cutoffSeq }}
              </Badge>
            </div>
            <p class="whitespace-pre-wrap font-medium">
              {{ data.current.contract?.contract.goal }}
            </p>
            <p
              v-if="data.current.state === 'finalizing'"
              class="text-xs text-muted-foreground"
            >
              待处理消息：{{ data.current.unconsumedInboxCount ?? 0 }}
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
                终止当前任务
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Separator />

      <Collapsible v-model:open="queueOpen" class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <ListOrdered :size="14" />
            <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">任务队列</h3>
          </div>
          <div class="flex items-center gap-2">
            <Badge>{{ queue.length }}</Badge>
            <CollapsibleTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                class="size-8"
              >
                <ChevronsUpDown />
                <span class="sr-only">{{ queueOpen ? '收起任务队列' : '展开任务队列' }}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <Empty v-if="!queue.length" class="min-h-24 p-5">
            <EmptyHeader>
              <EmptyTitle>队列为空</EmptyTitle>
              <EmptyDescription>暂无排队任务。</EmptyDescription>
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
        </CollapsibleContent>
      </Collapsible>

      <Separator />

      <Collapsible v-model:open="draftsOpen" class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">任务草稿</h3>
          <div class="flex items-center gap-2">
            <Badge>{{ data.drafts.length }}</Badge>
            <CollapsibleTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                class="size-8"
              >
                <ChevronsUpDown />
                <span class="sr-only">{{ draftsOpen ? '收起任务草稿' : '展开任务草稿' }}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <Empty v-if="!data.drafts.length" class="min-h-24 p-5">
            <EmptyHeader>
              <EmptyTitle>暂无任务草稿</EmptyTitle>
              <EmptyDescription>主 Agent 创建草稿后会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <div v-else class="flex flex-col gap-2">
            <article
              v-for="draft in data.drafts"
              :key="draft.id"
              class="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3"
            >
              <div class="flex flex-wrap items-center gap-2">
                <Badge variant="warning">草稿</Badge>
                <Badge>版本 {{ draft.revision }}</Badge>
                <Badge>{{ policyLabels[draft.body.contract.policy] ?? draft.body.contract.policy }}</Badge>
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
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Separator />
      <Collapsible v-model:open="historyOpen" class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">任务历史</h3>
          <div class="flex items-center gap-2">
            <Badge>{{ data.history.length }}</Badge>
            <CollapsibleTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                class="size-8"
              >
                <ChevronsUpDown />
                <span class="sr-only">{{ historyOpen ? '收起任务历史' : '展开任务历史' }}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent class="flex flex-col gap-2">
          <Empty v-if="!data.history.length" class="min-h-20 p-4">
            <EmptyHeader>
              <EmptyTitle>暂无任务历史</EmptyTitle>
            </EmptyHeader>
          </Empty>
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
        </CollapsibleContent>
      </Collapsible>
    </template>
  </div>
</template>
