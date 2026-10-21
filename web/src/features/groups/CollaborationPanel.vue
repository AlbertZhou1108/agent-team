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
          <Badge>{{ label(data.state.phase) }}</Badge>
          <Badge v-if="data.state.outcome">{{ label(data.state.outcome) }}</Badge>
          <Badge>契约 v{{ data.contract.version }}</Badge>
        </div>
        <p>{{ data.runningCount ?? 0 }} 个运行 · {{ data.pendingMessages?.length ?? 0 }} 条未处理消息 · {{ pending.length }} 项待用户决定</p>
        <details v-for="runtime in data.unknown" :key="runtime.turn_id" open>
          <summary>宿主运行待核实</summary>
          <p class="break-all">{{ runtime.turn_id }} · {{ runtime.detail }}</p>
        </details>
        <p v-if="data.state.final" class="whitespace-pre-wrap">{{ data.state.final }}</p>
        <p v-if="data.state.finish_reason">收尾依据：{{ data.state.finish_reason }}</p>
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
        <h3 class="font-semibold">工作项 · {{ data.items.length }}</h3>
        <p v-if="!data.items.length">主 Agent尚未建立工作项。</p>
        <details v-for="item in data.items" :key="item.id" class="min-w-0" open>
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

      <section v-if="data.requests.length" class="flex flex-col gap-2">
        <h3 class="font-semibold">用户决定</h3>
        <p>请在 CLI 中查看并决定，面板仅展示。</p>
        <details v-for="request in data.requests" :key="request.id">
          <summary>{{ request.kind === 'contract' ? '契约变更' : '新增成员' }} · {{ label(request.state) }}</summary>
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
