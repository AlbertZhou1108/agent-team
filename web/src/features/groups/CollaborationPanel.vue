<script setup lang="ts">
import { computed } from 'vue';
import PanelState from '@/components/panel/PanelState.vue';
import RecordPanel from '@/components/panel/RecordPanel.vue';
import CodeBlock from '@/components/ai-elements/CodeBlock.vue';
import { ChevronRight } from '@lucide/vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useCollaborationQuery } from '@/features/queries';
import type { Member } from '@/shared/api/raw-types';

const props = defineProps<{ groupId: string; members: Member[] }>();
const query = useCollaborationQuery(() => props.groupId || undefined);
const data = query.state;
const labels: Record<string, string> = {
  active: '进行中',
  closing: '收尾中',
  closed: '已结束',
  completed: '目标完成',
  incomplete: '目标未完成',
  pending: '待处理',
  in_progress: '执行中',
  blocked: '受阻',
  pending_decision: '待主 Agent决定',
  accepted: '已接受',
  cancelled: '已取消',
  executor: '执行者',
  collaborator: '协作者',
  reviewer: '审查者',
  communication: '仅沟通',
  'read-only': '项目只读',
  'workspace-write': '允许修改',
  approved: '用户已批准',
  rejected: '用户已拒绝',
};
const label = (value: string) => labels[value] ?? value;
const name = (id: string) => props.members.find((m) => m.id === id)?.name ?? id;
const pending = computed(
  () => data.value?.requests.filter((r) => r.state === 'pending') ?? [],
);
const phaseLabel = computed(() => {
  const state = data.value?.state;
  if (state?.phase !== 'closed') return label(state?.phase ?? '');
  return state.outcome === 'completed'
    ? '目标已完成 · 群可继续沟通'
    : '目标未完成 · 群可继续沟通';
});
const goalItems = computed(() => {
  const state = data.value?.state;
  return state
    ? (data.value?.items.filter(
        (item) => item.goalVersion === state.goal_version,
      ) ?? [])
    : [];
});
const goalItemsHeading = computed(() => {
  const state = data.value?.state;
  if (!state) return '目标工作项';
  if (state.phase === 'active' || state.phase === 'closing') {
    return `当前目标工作项 · ${goalItems.value.length}`;
  }
  return `目标 #${state.goal_version} 工作项 · ${goalItems.value.length}`;
});
const historicalItems = computed(() => {
  const state = data.value?.state;
  return state
    ? (data.value?.items.filter(
        (item) => item.goalVersion !== state.goal_version,
      ) ?? [])
    : [];
});
const currentOutput = computed(() => {
  const state = data.value?.state;
  return state
    ? (data.value?.outputs?.find(
        (output) => output.goalVersion === state.goal_version,
      ) ?? null)
    : null;
});
const historicalOutputs = computed(() => {
  const state = data.value?.state;
  return state
    ? (data.value?.outputs?.filter(
        (output) => output.goalVersion !== state.goal_version,
      ) ?? [])
    : [];
});
const effectivePolicy = (item: { policy: string }, role: string) =>
  role === 'reviewer' && item.policy === 'workspace-write'
    ? 'read-only'
    : item.policy;
</script>

<template>
  <div
    class="flex flex-col collaboration-content gap-6 p-1 text-sm leading-relaxed"
    data-testid="collaboration-panel"
  >
    <PanelState v-if="query.isPending.value" loading title="正在读取协作状态" description="正在同步目标契约和工作项。" />
    <Alert v-else-if="query.error.value" variant="destructive"><AlertDescription>读取失败：{{ query.error.value.message }}</AlertDescription></Alert>
    <PanelState v-else-if="data?.legacy" title="尚未确认目标契约" description="历史记录仍可查看。继续工作前，请在 CLI 中准备并确认契约。" />
    <template v-else-if="data?.contract && data.state">
      <section class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
          目标执行状态
        </h3>
        <div class="flex flex-wrap gap-2">
          <p class="w-full text-base font-semibold text-foreground">
            {{ phaseLabel }}
          </p>
          <Badge>目标 #{{ data.state.goal_version }}</Badge>
          <Badge>契约 v{{ data.contract.version }}</Badge>
        </div>
        <p class="text-xs text-muted-foreground">
          {{ data.runningCount ?? 0 }} 个运行 ·
          {{ data.pendingMessages?.length ?? 0 }} 条未处理消息 ·
          {{ pending.length }} 项待用户决定
        </p>
        <p
          v-if="data.state.phase === 'closed' && data.communicationOpen"
          class="text-xs text-muted-foreground"
        >
          当前目标已经结束，群保持开放；后续交流默认仅沟通，不会自动恢复旧目标。需要新执行任务时，请由主
          Agent提出下一版目标并由你确认。
        </p>
        <details v-for="runtime in data.unknown" :key="runtime.turn_id" open>
          <summary>宿主运行待核实</summary>
          <p class="break-all">{{ runtime.turn_id }} · {{ runtime.detail }}</p>
        </details>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
          用户确认的目标契约
        </h3>
        <p class="whitespace-pre-wrap">{{ data.contract.body.goal }}</p>
        <ol
          class="flex list-decimal flex-col gap-2 pl-5 text-xs text-muted-foreground"
        >
          <li
            v-for="criterion in data.contract.body.criteria"
            :key="criterion.id"
          >
            {{ criterion.text }}
          </li>
        </ol>
        <details>
          <summary class="cursor-pointer">范围、授权与交付</summary>
          <dl class="mt-4 flex flex-col gap-4 whitespace-pre-wrap">
            <div>
              <dt class="text-muted-foreground">范围</dt>
              <dd>{{ data.contract.body.scope }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">边界</dt>
              <dd>{{ data.contract.body.boundary }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">必须确认</dt>
              <dd>{{ data.contract.body.confirmation }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">交付</dt>
              <dd>{{ data.contract.body.delivery }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">执行策略</dt>
              <dd>
                {{ label(data.contract.body.policy) }} · 命令执行{{
                  data.contract.body.allowShell ? '已授权' : '未授权'
                }}
              </dd>
            </div>
          </dl>
          <p class="mt-4 break-all font-mono text-xs text-muted-foreground" title="契约校验值">
            {{ data.contract.hash }}
          </p>
        </details>
      </section>

      <section class="flex flex-col gap-3">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
          {{ goalItemsHeading }}
        </h3>
        <p v-if="!goalItems.length">主 Agent尚未建立该目标的工作项。</p>
        <Card v-for="item in goalItems" :key="item.id" class="min-w-0">
          <CardContent><details>
            <summary class="cursor-pointer">
              {{ item.title }} <Badge>{{ label(item.state) }}</Badge>
            </summary>
            <div class="mt-3 flex flex-col gap-2 text-xs text-muted-foreground">
              <p>{{ item.purpose }}</p>
              <p>接受标准：{{ item.standard }}</p>
              <p
                v-for="participant in item.participants"
                :key="participant.memberId"
              >
                {{ name(participant.memberId) }} ·
                {{ label(participant.role) }} ·
                {{ label(effectivePolicy(item, participant.role)) }}
              </p>
              <p>
                工作项需求 {{ label(item.policy) }} · 命令{{
                  item.allowShell ? '允许' : '禁止'
                }}
                ·
                {{
                  item.reviewRequired ? '要求独立审查' : '主 Agent决定是否审查'
                }}
              </p>
              <p v-if="item.artifact" class="break-all">
                成果版本：{{ item.artifact }}
              </p>
              <details v-if="item.evidence.length || item.reviews.length">
                <summary>
                  贡献 {{ item.evidence.length }} · 审查
                  {{ item.reviews.length }}
                </summary>
                <p v-for="id in item.evidence" :key="id" class="break-all">
                  汇报消息：{{ id }}
                </p>
                <p
                  v-for="review in item.reviews"
                  :key="review.messageId"
                  class="break-all"
                >
                  审查消息：{{ review.messageId }} · {{ review.artifact }}
                </p>
              </details>
            </div>
          </details></CardContent>
        </Card>
      </section>

      <section v-if="historicalItems.length" class="flex flex-col gap-3">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
          历史目标工作项 · {{ historicalItems.length }}
        </h3>
        <details v-for="item in historicalItems" :key="item.id" class="min-w-0">
          <summary class="cursor-pointer">
            目标 #{{ item.goalVersion }} · {{ item.title }}
            <Badge>{{ label(item.state) }}</Badge>
          </summary>
          <div class="mt-3 flex flex-col gap-2 text-xs text-muted-foreground">
            <p>{{ item.purpose }}</p>
            <p>接受标准：{{ item.standard }}</p>
            <p v-if="item.artifact" class="break-all">
              成果版本：{{ item.artifact }}
            </p>
            <p>
              贡献 {{ item.evidence.length }} · 审查 {{ item.reviews.length }}
            </p>
          </div>
        </details>
      </section>

      <section
        v-if="currentOutput || data.state.final"
        class="flex flex-col gap-2"
      >
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
          交付结果
        </h3>
        <Card class="flex flex-col">
          <CardContent class="flex flex-col gap-3">
          <p class="whitespace-pre-wrap">
            {{ currentOutput?.body ?? data.state.final }}
          </p>
          <p v-if="currentOutput" class="text-xs text-muted-foreground">
            {{ new Date(currentOutput.created).toLocaleString('zh-CN') }}
          </p>
          </CardContent>
        </Card>
      </section>

      <section v-if="historicalOutputs.length" class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
          历史交付
        </h3>
        <Card v-for="output in historicalOutputs" :key="output.id">
          <CardContent><details>
            <summary class="cursor-pointer">
              目标 #{{ output.goalVersion }} ·
              {{ new Date(output.created).toLocaleString('zh-CN') }}
            </summary>
            <p class="mt-2 whitespace-pre-wrap">{{ output.body }}</p>
          </details></CardContent>
        </Card>
      </section>

      <section v-if="data.requests.length" class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
          用户决定
        </h3>
        <p>请在 CLI 中查看并决定，面板仅展示。</p>
        <details v-for="request in data.requests" :key="request.id">
          <summary>
            {{
              request.kind === 'contract'
                ? '契约变更'
                : request.kind === 'next_goal'
                  ? '下一版目标'
                  : '新增成员'
            }}
            · {{ label(request.state) }}
          </summary>
          <pre class="whitespace-pre-wrap break-all">{{
            JSON.stringify(request.body, null, 2)
          }}</pre>
        </details>
      </section>

      <RecordPanel v-if="query.records.value.length || query.hasNextPage.value" title="决定与流转记录" :count="query.records.value.length">
        <details v-for="record in query.records.value" :key="record.seq" data-record-row class="group">
          <summary class="flex cursor-pointer items-center gap-2 py-2 text-xs">
            <span class="min-w-0 flex-1 break-words">#{{ record.seq }} {{ record.type }}</span>
            <time class="shrink-0 text-muted-foreground tabular-nums">{{ new Date(record.created).toLocaleTimeString('zh-CN') }}</time>
            <ChevronRight class="size-4 shrink-0 group-open:rotate-90" />
          </summary>
          <CodeBlock :code="JSON.stringify(record.body, null, 2)" max-height="12rem" />
        </details>
        <template v-if="query.hasNextPage.value" #footer>
        <Button
          variant="outline"
          size="sm"
          :disabled="query.isFetchingNextPage.value"
          @click="query.fetchNextPage()"
          >{{ query.isFetchingNextPage.value ? '正在加载' : '加载更多记录' }}</Button>
        </template>
      </RecordPanel>
    </template>
  </div>
</template>
