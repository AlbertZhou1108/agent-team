<script setup lang="ts">
import { computed } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCollaborationQuery } from '@/features/queries';
import type { Member } from '@/shared/api/raw-types';

const props = defineProps<{ groupId: string; members: Member[] }>();
const query = useCollaborationQuery(() => props.groupId || undefined);
const data = query.state;
const labels: Record<string, string> = { active: '进行中', closing: '收尾中', closed: '已结束', completed: '目标完成', incomplete: '目标未完成', pending: '待处理', in_progress: '执行中', blocked: '受阻', pending_decision: '待主 Agent决定', accepted: '已接受', cancelled: '已取消', executor: '执行者', collaborator: '协作者', reviewer: '审查者', communication: '仅沟通', 'read-only': '项目只读', 'workspace-write': '允许修改', approved: '用户已批准', rejected: '用户已拒绝' };
const label = (value: string) => labels[value] ?? value;
const name = (id: string) => props.members.find(m => m.id === id)?.name ?? id;
const pending = computed(() => data.value?.requests.filter(r => r.state === 'pending') ?? []);
const phaseLabel = computed(() => {
  const state = data.value?.state;
  if (state?.phase !== 'closed') return label(state?.phase ?? '');
  return state.outcome === 'completed' ? '目标已完成 · 群可继续沟通' : '目标未完成 · 群可继续沟通';
});
const currentItems = computed(() => {
  const state = data.value?.state;
  return state ? data.value?.items.filter(item => item.goalVersion === state.goal_version) ?? [] : [];
});
const historicalItems = computed(() => {
  const state = data.value?.state;
  return state ? data.value?.items.filter(item => item.goalVersion !== state.goal_version) ?? [] : [];
});
const effectivePolicy = (item: { policy: string }, role: string) => (
  role === 'reviewer' && item.policy === 'workspace-write' ? 'read-only' : item.policy
);
</script>

<template>
  <div class="flex flex-col gap-5 p-1 text-xs leading-relaxed" data-testid="collaboration-panel">
    <p v-if="query.isPending.value" role="status">正在读取协作状态…</p>
    <p v-else-if="query.error.value" role="alert">读取失败：{{ query.error.value.message }}</p>
    <p v-else-if="data?.legacy">本群尚未确认目标契约，保留历史供查看。继续工作前请在 CLI 中准备并确认契约。</p>
    <template v-else-if="data?.contract && data.state">
      <section class="flex flex-col gap-2">
        <h3 class="font-semibold">团队状态</h3>
        <div class="flex flex-wrap gap-2">
          <Badge>{{ phaseLabel }}</Badge>
          <Badge v-if="data.state.outcome">{{ label(data.state.outcome) }}</Badge>
          <Badge>目标 #{{ data.state.goal_version }}</Badge>
          <Badge>契约 v{{ data.contract.version }}</Badge>
        </div>
        <p>{{ data.runningCount ?? 0 }} 个运行 · {{ data.pendingMessages?.length ?? 0 }} 条未处理消息 · {{ pending.length }} 项待用户决定</p>
        <p v-if="data.state.phase === 'closed' && data.communicationOpen" class="text-muted-foreground">当前目标已经结束，群保持开放；后续交流默认仅沟通，不会自动恢复旧目标。需要新执行任务时，请由主 Agent提出下一版目标并由你确认。</p>
        <details v-for="runtime in data.unknown" :key="runtime.turn_id" open>
          <summary>宿主运行待核实</summary>
          <p class="break-all">{{ runtime.turn_id }} · {{ runtime.detail }}</p>
        </details>
        <p v-if="data.state.final" class="whitespace-pre-wrap">{{ data.state.final }}</p>
        <p v-if="data.state.finish_reason">{{ data.state.outcome === 'completed' ? '完成依据' : '结束依据' }}：{{ data.state.finish_reason }}</p>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="font-semibold">用户确认的目标契约</h3>
        <p class="whitespace-pre-wrap">{{ data.contract.body.goal }}</p>
        <ol class="list-inside list-decimal">
          <li v-for="criterion in data.contract.body.criteria" :key="criterion.id">{{ criterion.text }}</li>
        </ol>
        <details>
          <summary class="cursor-pointer">范围、授权与交付</summary>
          <dl class="mt-2 flex flex-col gap-2 whitespace-pre-wrap">
            <div><dt class="text-muted-foreground">范围</dt><dd>{{ data.contract.body.scope }}</dd></div>
            <div><dt class="text-muted-foreground">边界</dt><dd>{{ data.contract.body.boundary }}</dd></div>
            <div><dt class="text-muted-foreground">必须确认</dt><dd>{{ data.contract.body.confirmation }}</dd></div>
            <div><dt class="text-muted-foreground">交付</dt><dd>{{ data.contract.body.delivery }}</dd></div>
            <div><dt class="text-muted-foreground">执行策略</dt><dd>{{ label(data.contract.body.policy) }} · 命令执行{{ data.contract.body.allowShell ? '已授权' : '未授权' }}</dd></div>
          </dl>
          <p class="mt-2 break-all font-mono text-muted-foreground">{{ data.contract.hash }}</p>
        </details>
      </section>

      <section class="flex flex-col gap-3">
        <h3 class="font-semibold">当前目标工作项 · {{ currentItems.length }}</h3>
        <p v-if="!currentItems.length">主 Agent尚未建立当前目标的工作项。</p>
        <details v-for="item in currentItems" :key="item.id" class="min-w-0" open>
          <summary class="cursor-pointer">{{ item.title }} <Badge>{{ label(item.state) }}</Badge></summary>
          <div class="mt-2 flex flex-col gap-2">
            <p>{{ item.purpose }}</p>
            <p>接受标准：{{ item.standard }}</p>
            <p v-for="participant in item.participants" :key="participant.memberId">
              {{ name(participant.memberId) }} · {{ label(participant.role) }} · {{ label(effectivePolicy(item, participant.role)) }}
            </p>
            <p>工作项需求 {{ label(item.policy) }} · 命令{{ item.allowShell ? '允许' : '禁止' }} · {{ item.reviewRequired ? '要求独立审查' : '主 Agent决定是否审查' }}</p>
            <p v-if="item.artifact" class="break-all">成果版本：{{ item.artifact }}</p>
            <details v-if="item.evidence.length || item.reviews.length">
              <summary>贡献 {{ item.evidence.length }} · 审查 {{ item.reviews.length }}</summary>
              <p v-for="id in item.evidence" :key="id" class="break-all">汇报消息：{{ id }}</p>
              <p v-for="review in item.reviews" :key="review.messageId" class="break-all">审查消息：{{ review.messageId }} · {{ review.artifact }}</p>
            </details>
          </div>
        </details>
      </section>

      <section v-if="historicalItems.length" class="flex flex-col gap-3">
        <h3 class="font-semibold">历史目标工作项 · {{ historicalItems.length }}</h3>
        <details v-for="item in historicalItems" :key="item.id" class="min-w-0">
          <summary class="cursor-pointer">目标 #{{ item.goalVersion }} · {{ item.title }} <Badge>{{ label(item.state) }}</Badge></summary>
          <div class="mt-2 flex flex-col gap-2">
            <p>{{ item.purpose }}</p>
            <p>接受标准：{{ item.standard }}</p>
            <p v-if="item.artifact" class="break-all">成果版本：{{ item.artifact }}</p>
            <p>贡献 {{ item.evidence.length }} · 审查 {{ item.reviews.length }}</p>
          </div>
        </details>
      </section>

      <section v-if="data.outputs?.length" class="flex flex-col gap-2">
        <h3 class="font-semibold">目标交付历史</h3>
        <details v-for="output in data.outputs" :key="output.id">
          <summary class="cursor-pointer">目标 #{{ output.goalVersion }} · {{ new Date(output.created).toLocaleString('zh-CN') }}</summary>
          <p class="mt-2 whitespace-pre-wrap">{{ output.body }}</p>
        </details>
      </section>

      <section v-if="data.requests.length" class="flex flex-col gap-2">
        <h3 class="font-semibold">用户决定</h3>
        <p>请在 CLI 中查看并决定，面板仅展示。</p>
        <details v-for="request in data.requests" :key="request.id">
          <summary>{{ request.kind === 'contract' ? '契约变更' : request.kind === 'next_goal' ? '下一版目标' : '新增成员' }} · {{ label(request.state) }}</summary>
          <pre class="whitespace-pre-wrap break-all">{{ JSON.stringify(request.body, null, 2) }}</pre>
        </details>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="font-semibold">决定与流转记录</h3>
        <details v-for="record in query.records.value" :key="record.seq">
          <summary class="cursor-pointer">#{{ record.seq }} {{ record.type }} · {{ new Date(record.created).toLocaleTimeString('zh-CN') }}</summary>
          <pre class="whitespace-pre-wrap break-all">{{ JSON.stringify(record.body, null, 2) }}</pre>
        </details>
        <Button v-if="query.hasNextPage.value" variant="outline" size="sm" :disabled="query.isFetchingNextPage.value" @click="query.fetchNextPage()">加载更多记录</Button>
      </section>
    </template>
  </div>
</template>
