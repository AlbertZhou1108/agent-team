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
import { Item } from '@/components/ui/item';
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
import PanelState from '@/components/panel/PanelState.vue';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import PromptDialog from '@/components/panel/PromptDialog.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
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

type ConfirmRequest = {
  title: string;
  description?: string;
  confirmText?: string;
  destructive?: boolean;
  run: () => Promise<void> | void;
};
const confirmRequest = ref<ConfirmRequest | null>(null);

type PromptRequest = {
  title: string;
  description?: string;
  placeholder?: string;
  confirmText?: string;
  destructive?: boolean;
  run: (value: string) => Promise<void> | void;
};
const promptRequest = ref<PromptRequest | null>(null);

function askConfirm(request: ConfirmRequest) {
  confirmRequest.value = request;
}

async function runConfirm() {
  const request = confirmRequest.value;
  if (!request) return;
  confirmRequest.value = null;
  await request.run();
}

function cancelConfirm() {
  confirmRequest.value = null;
}

function askPrompt(request: PromptRequest) {
  promptRequest.value = request;
}

async function runPrompt(value: string) {
  const request = promptRequest.value;
  if (!request) return;
  promptRequest.value = null;
  await request.run(value);
}

function cancelPrompt() {
  promptRequest.value = null;
}

watch(
  () => data.value?.queue,
  (value) => {
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
  (id) => {
    currentOpen.value = Boolean(id);
  },
  { immediate: true },
);
watch(
  () => data.value?.queue.length ?? 0,
  (count) => {
    queueOpen.value = count > 0;
  },
  { immediate: true },
);
watch(
  () => data.value?.drafts.length ?? 0,
  (count) => {
    draftsOpen.value = count > 0;
  },
  { immediate: true },
);
watch(
  () => data.value?.history.length ?? 0,
  (count) => {
    historyOpen.value = count > 0;
  },
  { immediate: true },
);

function stateVariant(state: GoalState) {
  if (state === 'active') return 'secondary';
  if (state === 'finalizing') return 'outline';
  if (state === 'terminated' || state === 'cancelled') return 'destructive';
  if (state === 'completed') return 'secondary';
  return 'default';
}

function nextOperationId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `goal-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
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
  if (!data.value) return;
  const revision = data.value.team.revision;
  askConfirm({
    title: '确认这个目标草稿并加入队列？',
    description: `草稿版本 ${draftRevision}；确认后按团队当前 revision ${revision} 加入目标队列。`,
    confirmText: '确认并排队',
    run: () =>
      run(
        () =>
          api.confirmGoalDraft(props.teamId, draftId, {
            revision,
            operationId: nextOperationId(),
            draftRevision,
            hash,
          }),
        '目标草稿已确认',
      ),
  });
}

function deleteDraft(draftId: string, draftRevision: number) {
  if (!data.value) return;
  const revision = data.value.team.revision;
  askConfirm({
    title: '删除这个目标草稿？',
    description: '删除后需要主 Agent 重新创建草稿。',
    confirmText: '删除',
    destructive: true,
    run: () =>
      run(
        () =>
          api.deleteGoalDraft(props.teamId, draftId, {
            revision,
            operationId: nextOperationId(),
            draftRevision,
          }),
        '目标草稿已删除',
      ),
  });
}

function cancelGoal(goalId: string) {
  if (!data.value) return;
  const revision = data.value.team.revision;
  askPrompt({
    title: '取消这个排队目标？',
    description: '请填写取消原因，原因会记录到团队历史。',
    placeholder: '取消原因',
    confirmText: '取消目标',
    destructive: true,
    run: (reason) =>
      run(
        () =>
          api.cancelQueuedGoal(props.teamId, goalId, {
            revision,
            operationId: nextOperationId(),
            reason,
          }),
        '排队目标已取消',
      ),
  });
}

function withdrawFinish(goalId: string) {
  if (!data.value) return;
  const revision = data.value.team.revision;
  askPrompt({
    title: '撤回收尾请求？',
    description: '撤回后团队恢复执行，请填写撤回原因。',
    placeholder: '撤回原因',
    confirmText: '撤回收尾',
    run: (reason) =>
      run(
        () =>
          api.withdrawGoalFinish(props.teamId, goalId, {
            revision,
            operationId: nextOperationId(),
            reason,
          }),
        '已撤回目标收尾',
      ),
  });
}

function terminateCurrent(goalId: string) {
  if (!data.value) return;
  const revision = data.value.team.revision;
  askPrompt({
    title: '终止当前目标？',
    description: '该操作不会删除团队历史；请填写终止原因。',
    placeholder: '终止原因',
    confirmText: '终止目标',
    destructive: true,
    run: (reason) =>
      run(
        () =>
          api.terminateGoal(props.teamId, goalId, {
            revision,
            operationId: nextOperationId(),
            reason,
          }),
        '当前目标已终止',
      ),
  });
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
  const from = next.findIndex((goal) => goal.id === sourceId);
  const to = next.findIndex((goal) => goal.id === targetId);
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
    () =>
      api.reorderGoalQueue(props.teamId, {
        revision: data.value!.team.revision,
        operationId: nextOperationId(),
        orderedGoalIds: next.map((goal) => goal.id),
      }),
    '目标队列顺序已保存',
  );
}
</script>

<template>
  <div class="flex flex-col gap-5 p-1 text-sm">
    <PanelState v-if="query.isPending.value" loading title="正在读取目标状态" description="正在同步当前目标与历史记录。" />
    <Alert v-else-if="query.error.value" variant="destructive">
      <AlertDescription>{{ query.error.value.message }}</AlertDescription>
      <Button variant="outline" size="sm" @click="query.refetch()">重新加载</Button>
    </Alert>
    <template v-else-if="data">
      <div
        v-if="data.current || queue.length || data.drafts.length"
        class="flex flex-wrap items-center gap-2"
      >
        <Badge variant="secondary">{{
          data.current ? `当前目标 #${data.current.number}` : '无当前目标'
        }}</Badge>
        <Badge v-if="queue.length" variant="outline"
          >{{ queue.length }} 个排队目标</Badge
        >
        <Badge v-if="data.drafts.length" variant="outline"
          >{{ data.drafts.length }} 个目标草稿</Badge
        >
      </div>

      <Empty v-if="!data.current">
        <EmptyHeader
          ><EmptyMedia variant="icon"><Target /></EmptyMedia
          ><EmptyTitle>暂无进行中的目标</EmptyTitle
          ><EmptyDescription>{{
            data.history.length
              ? '已结束的目标保留在下方历史中，团队仍可继续交流。'
              : '目标确认后，执行进展会显示在这里。'
          }}</EmptyDescription></EmptyHeader
        >
      </Empty>
      <Collapsible
        v-if="data.current"
        v-model:open="currentOpen"
        class="flex flex-col"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <Target />
            <h3
              class="text-xs font-semibold tracking-wide text-muted-foreground"
            >
              当前目标
            </h3>
          </div>
          <div class="flex items-center gap-2">
            <Badge
              v-if="data.current"
              :variant="stateVariant(data.current.state)"
            >
              {{ stateLabels[data.current.state] }}
            </Badge>
            <CollapsibleTrigger as-child>
              <Button variant="ghost" size="icon">
                <ChevronsUpDown />
                <span class="sr-only">{{
                  currentOpen ? '收起当前目标' : '展开当前目标'
                }}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <Empty v-if="!data.current" class="min-h-28">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3 />
              </EmptyMedia>
              <EmptyTitle>无当前目标</EmptyTitle>
              <EmptyDescription
                >可以继续普通交流，或等待新的目标草稿。</EmptyDescription
              >
            </EmptyHeader>
          </Empty>
          <div v-else class="flex flex-col gap-3 border p-3">
            <div class="flex flex-wrap items-center gap-2">
              <Badge variant="default">目标 #{{ data.current.number }}</Badge>
              <Badge v-if="data.current.contract?.contract.policy">
                {{
                  policyLabels[data.current.contract.contract.policy] ??
                  data.current.contract.contract.policy
                }}
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

      <Separator v-if="queue.length" />

      <Collapsible
        v-if="queue.length"
        v-model:open="queueOpen"
        class="flex flex-col"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <ListOrdered />
            <h3
              class="text-xs font-semibold tracking-wide text-muted-foreground"
            >
              目标队列
            </h3>
          </div>
          <div class="flex items-center gap-2">
            <Badge variant="outline">{{ queue.length }}</Badge>
            <CollapsibleTrigger as-child>
              <Button variant="ghost" size="icon">
                <ChevronsUpDown />
                <span class="sr-only">{{
                  queueOpen ? '收起目标队列' : '展开目标队列'
                }}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <Empty v-if="!queue.length" class="min-h-24">
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
              class="flex cursor-grab flex-col gap-2 border p-3 transition-[opacity,transform,border-color] duration-200 active:cursor-grabbing"
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
                <GripVertical class="mt-0.5 shrink-0" />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-xs text-muted-foreground"
                      >目标 #{{ goal.number }}</span
                    >
                    <Badge
                      :variant="
                        goal.eligibility?.eligible ? 'secondary' : 'outline'
                      "
                    >
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
                class="flex flex-col gap-1 p-2 text-muted-foreground"
              >
                <p
                  v-for="blocker in goal.eligibility.blockers"
                  :key="blocker.code"
                  class="flex items-start gap-1"
                >
                  <ShieldAlert class="mt-0.5 shrink-0" />
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

      <Separator v-if="data.drafts.length" />

      <Collapsible
        v-if="data.drafts.length"
        v-model:open="draftsOpen"
        class="flex flex-col"
      >
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
            目标草稿
          </h3>
          <div class="flex items-center gap-2">
            <Badge variant="outline">{{ data.drafts.length }}</Badge>
            <CollapsibleTrigger as-child>
              <Button variant="ghost" size="icon">
                <ChevronsUpDown />
                <span class="sr-only">{{
                  draftsOpen ? '收起目标草稿' : '展开目标草稿'
                }}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <Empty v-if="!data.drafts.length" class="min-h-24">
            <EmptyHeader>
              <EmptyTitle>暂无目标草稿</EmptyTitle>
              <EmptyDescription
                >主 Agent 创建草稿后会显示在这里。</EmptyDescription
              >
            </EmptyHeader>
          </Empty>
          <div v-else class="flex flex-col gap-2">
            <article
              v-for="draft in data.drafts"
              :key="draft.id"
              class="flex flex-col gap-3 border p-3"
            >
              <div class="flex flex-wrap items-center gap-2">
                <Badge variant="outline">草稿</Badge>
                <Badge>版本 {{ draft.revision }}</Badge>
                <Badge>{{
                  policyLabels[draft.body.contract.policy] ??
                  draft.body.contract.policy
                }}</Badge>
              </div>
              <p class="whitespace-pre-wrap font-medium">
                {{ draft.body.contract.goal }}
              </p>
              <ol
                class="flex list-decimal flex-col gap-1 pl-5 text-xs text-muted-foreground"
              >
                <li
                  v-for="criterion in draft.body.contract.criteria"
                  :key="criterion.id"
                >
                  {{ criterion.text }}
                </li>
              </ol>
              <p class="break-all font-mono text-muted-foreground">
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

      <Separator v-if="data.history.length" />
      <Collapsible v-if="data.history.length" v-model:open="historyOpen" class="flex flex-col">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
            目标历史
          </h3>
          <div class="flex items-center gap-2">
            <Badge variant="outline">{{ data.history.length }}</Badge>
            <CollapsibleTrigger as-child>
              <Button variant="ghost" size="icon">
                <ChevronsUpDown />
                <span class="sr-only">{{
                  historyOpen ? '收起目标历史' : '展开目标历史'
                }}</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent class="flex flex-col">
          <Empty v-if="!data.history.length" class="min-h-20">
            <EmptyHeader>
              <EmptyTitle>暂无目标历史</EmptyTitle>
            </EmptyHeader>
          </Empty>
          <Item
            variant="outline"
            v-for="goal in data.history"
            :key="goal.id"
            class="overflow-hidden"
          >
            <Collapsible v-model:open="historyCardOpen[goal.id]">
              <CollapsibleTrigger as-child>
                <button
                  type="button"
                  class="flex w-full flex-col gap-3 text-left transition-colors focus-visible:outline-none"
                >
                  <span class="flex w-full items-start justify-between gap-2">
                    <span class="flex flex-wrap items-center gap-2">
                      <span class="text-xs text-muted-foreground"
                        >目标 #{{ goal.number }}</span
                      >
                      <Badge :variant="stateVariant(goal.state)">
                        {{ stateLabels[goal.state] }}
                      </Badge>
                      <Badge
                        v-if="goal.contract?.contract.policy"
                        variant="outline"
                      >
                        {{
                          policyLabels[goal.contract.contract.policy] ??
                          goal.contract.contract.policy
                        }}
                      </Badge>
                    </span>
                    <ChevronsUpDown
                      class="size-4 shrink-0"
                      :class="{ 'rotate-180': historyCardOpen[goal.id] }"
                    />
                  </span>
                  <span
                    class="block line-clamp-2 whitespace-pre-wrap text-sm leading-6"
                  >
                    {{ goal.contract?.contract.goal ?? '目标内容不可用' }}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div class="flex flex-col gap-3 px-3 py-3 text-xs">
                  <div class="flex flex-col gap-1">
                    <span class="font-medium text-muted-foreground"
                      >目标正文</span
                    >
                    <p class="whitespace-pre-wrap leading-5">
                      {{ goal.contract?.contract.goal ?? '目标正文不可用' }}
                    </p>
                  </div>
                  <div v-if="goal.finishReason" class="flex flex-col gap-1">
                    <span class="font-medium text-muted-foreground"
                      >收尾说明</span
                    >
                    <p class="whitespace-pre-wrap leading-5">
                      {{ goal.finishReason }}
                    </p>
                  </div>
                  <dl
                    class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"
                  >
                    <dt
                      v-if="goal.cutoffSeq !== null"
                      class="text-muted-foreground"
                    >
                      收尾截止
                    </dt>
                    <dd v-if="goal.cutoffSeq !== null">
                      #{{ goal.cutoffSeq }}
                    </dd>
                    <dt class="text-muted-foreground">开始</dt>
                    <dd>
                      {{
                        goal.started
                          ? new Date(goal.started).toLocaleString('zh-CN')
                          : '未开始'
                      }}
                    </dd>
                    <dt class="text-muted-foreground">结束</dt>
                    <dd>
                      {{
                        goal.ended
                          ? new Date(goal.ended).toLocaleString('zh-CN')
                          : '未结束'
                      }}
                    </dd>
                  </dl>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </Item>
        </CollapsibleContent>
      </Collapsible>
    </template>

    <ConfirmDialog
      :open="confirmRequest !== null"
      :title="confirmRequest?.title ?? ''"
      :description="confirmRequest?.description ?? ''"
      :confirm-text="confirmRequest?.confirmText ?? '确认'"
      :destructive="confirmRequest?.destructive ?? false"
      @confirm="runConfirm"
      @cancel="cancelConfirm"
    />
    <PromptDialog
      :open="promptRequest !== null"
      :title="promptRequest?.title ?? ''"
      :description="promptRequest?.description ?? ''"
      :placeholder="promptRequest?.placeholder ?? ''"
      :confirm-text="promptRequest?.confirmText ?? '确认'"
      :destructive="promptRequest?.destructive ?? false"
      @confirm="runPrompt"
      @cancel="cancelPrompt"
    />
  </div>
</template>
