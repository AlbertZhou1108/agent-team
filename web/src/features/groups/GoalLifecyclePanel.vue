<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
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
import { Card } from '@/components/ui/card';
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
const historyCardOpen = reactive<Record<string, boolean>>({});

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
    toast.error('目标操作失败', { description: String(error) });
    await query.refetch();
  } finally {
    busy.value = false;
  }
}

function confirmDraft(draftId: string, draftRevision: number, hash: string) {
  if (!data.value || !window.confirm('确认这个目标草稿并加入队列？')) return;
  void run(
    () => api.confirmGoalDraft(props.teamId, draftId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      draftRevision,
      hash,
    }),
    '目标草稿已确认',
  );
}

function deleteDraft(draftId: string, draftRevision: number) {
  if (!data.value || !window.confirm('删除这个目标草稿？')) return;
  void run(
    () => api.deleteGoalDraft(props.teamId, draftId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      draftRevision,
    }),
    '目标草稿已删除',
  );
}

function cancelGoal(goalId: string) {
  if (!data.value) return;
  const reason = window.prompt('取消这个排队目标的原因');
  if (!reason?.trim()) return;
  void run(
    () => api.cancelQueuedGoal(props.teamId, goalId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      reason: reason.trim(),
    }),
    '排队目标已取消',
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
    '已撤回目标收尾',
  );
}

function terminateCurrent(goalId: string) {
  if (!data.value || !window.confirm('终止当前目标？该操作不会删除团队历史。')) return;
  const reason = window.prompt('终止原因');
  if (!reason?.trim()) return;
  void run(
    () => api.terminateGoal(props.teamId, goalId, {
      revision: data.value!.team.revision,
      operationId: nextOperationId(),
      reason: reason.trim(),
    }),
    '当前目标已终止',
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
    '目标队列顺序已保存',
  );
}
</script>

<template>
  <div class="flex flex-col gap-5 p-1 text-sm">
    <p v-if="query.isPending.value" role="status">正在读取目标状态…</p>
    <p v-else-if="query.error.value" role="alert">读取失败：{{ query.error.value.message }}</p>
    <template v-else-if="data">
      <div class="flex flex-wrap items-center gap-2">
        <Badge>{{ data.current ? `当前目标 #${data.current.number}` : '无当前目标' }}</Badge>
        <Badge>{{ queue.length }} 个排队目标</Badge>
        <Badge>{{ data.drafts.length }} 个目标草稿</Badge>
      </div>

      <Collapsible v-model:open="currentOpen" class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <Target :size="14" />
            <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">当前目标</h3>
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
                <span class="sr-only">{{ currentOpen ? '收起当前目标' : '展开当前目标' }}</span>
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
              <EmptyTitle>无当前目标</EmptyTitle>
              <EmptyDescription>可以继续普通交流，或等待新的目标草稿。</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <div v-else class="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <Badge variant="accent">目标 #{{ data.current.number }}</Badge>
              <Badge v-if="data.current.contract?.contract.policy">
                {{ policyLabels[data.current.contract.contract.policy] ?? data.current.contract.contract.policy }}
              </Badge>
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
                终止当前目标
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
            <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">目标队列</h3>
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
                <span class="sr-only">{{ queueOpen ? '收起目标队列' : '展开目标队列' }}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <Empty v-if="!queue.length" class="min-h-24 p-5">
            <EmptyHeader>
              <EmptyTitle>目标队列为空</EmptyTitle>
              <EmptyDescription>暂无排队目标。</EmptyDescription>
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
          <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">目标草稿</h3>
          <div class="flex items-center gap-2">
            <Badge>{{ data.drafts.length }}</Badge>
            <CollapsibleTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                class="size-8"
              >
                <ChevronsUpDown />
                <span class="sr-only">{{ draftsOpen ? '收起目标草稿' : '展开目标草稿' }}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <Empty v-if="!data.drafts.length" class="min-h-24 p-5">
            <EmptyHeader>
              <EmptyTitle>暂无目标草稿</EmptyTitle>
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
          <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">目标历史</h3>
          <div class="flex items-center gap-2">
            <Badge>{{ data.history.length }}</Badge>
            <CollapsibleTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                class="size-8"
              >
                <ChevronsUpDown />
                <span class="sr-only">{{ historyOpen ? '收起目标历史' : '展开目标历史' }}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent class="flex flex-col gap-2">
          <Empty v-if="!data.history.length" class="min-h-20 p-4">
            <EmptyHeader>
                <EmptyTitle>暂无目标历史</EmptyTitle>
            </EmptyHeader>
          </Empty>
          <Card
            v-for="goal in data.history"
            :key="goal.id"
            class="overflow-hidden"
          >
            <Collapsible
              v-model:open="historyCardOpen[goal.id]"
            >
              <CollapsibleTrigger as-child>
                <button
                  type="button"
                  class="flex w-full flex-col gap-3 p-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-inset"
                >
                  <span class="flex w-full items-start justify-between gap-2">
                    <span class="flex flex-wrap items-center gap-2">
                      <Badge>#{{ goal.number }}</Badge>
                      <Badge :variant="stateVariant(goal.state)">
                        {{ stateLabels[goal.state] }}
                      </Badge>
                      <Badge v-if="goal.contract?.contract.policy">
                        {{ policyLabels[goal.contract.contract.policy] ?? goal.contract.contract.policy }}
                      </Badge>
                      <Badge v-if="goal.cutoffSeq !== null">
                        截止 #{{ goal.cutoffSeq }}
                      </Badge>
                    </span>
                    <ChevronsUpDown
                      :size="14"
                      class="shrink-0 text-muted-foreground transition-transform"
                      :class="{ 'rotate-180': historyCardOpen[goal.id] }"
                    />
                  </span>
                  <span class="block line-clamp-2 whitespace-pre-wrap text-xs leading-5">
                    {{ goal.contract?.contract.goal ?? '目标内容不可用' }}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div class="flex flex-col gap-3 border-t px-3 py-3 text-xs">
                  <div class="flex flex-col gap-1">
                    <span class="font-medium text-muted-foreground">目标正文</span>
                    <p class="whitespace-pre-wrap leading-5">
                      {{ goal.contract?.contract.goal ?? '目标正文不可用' }}
                    </p>
                  </div>
                  <div v-if="goal.finishReason" class="flex flex-col gap-1">
                    <span class="font-medium text-muted-foreground">收尾说明</span>
                    <p class="whitespace-pre-wrap leading-5">{{ goal.finishReason }}</p>
                  </div>
                  <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                    <dt class="text-muted-foreground">开始</dt>
                    <dd>{{ goal.started ? new Date(goal.started).toLocaleString('zh-CN') : '未开始' }}</dd>
                    <dt class="text-muted-foreground">结束</dt>
                    <dd>{{ goal.ended ? new Date(goal.ended).toLocaleString('zh-CN') : '未结束' }}</dd>
                  </dl>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        </CollapsibleContent>
      </Collapsible>
    </template>
  </div>
</template>
