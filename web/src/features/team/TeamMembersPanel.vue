<script setup lang="ts">
import { computed } from 'vue';
import { Coins, Database, Radio, Users } from '@lucide/vue';
import ExpandableText from '@/components/ai-elements/ExpandableText.vue';
import { SectionBlock } from '@/components/panel';
import PanelState from '@/components/panel/PanelState.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useMembersTelemetryQuery } from '@/features/queries';
import { compactNumber, numeric, ratioPercent } from '@/features/telemetry/visuals';
import type { Member, SessionEndpoint } from '@/shared/api/raw-types';

/**
 * 右栏「成员」视图：专注成员身份、宿主/模型配置与快捷联动。
 * 完整 9 项用量表收敛在「工具 → 协调遥测」，此处仅以纯图标展示轻量摘要；
 * 点击用量摘要跳至协调遥测，点击「查看轨迹」切至中间主区轨迹视图。
 */
const props = defineProps<{
  groupId: string;
  members: Member[];
  endpoints: SessionEndpoint[];
  runningMemberIds: Set<string>;
  pausedMemberIds?: Set<string>;
}>();

const emit = defineEmits<{
  editModel: [member: Member];
  openUsage: [memberId: string];
  openTrace: [sessionId: string];
}>();

const telemetryQuery = useMembersTelemetryQuery(() => props.groupId || undefined);

const telemetryByMember = computed(() => {
  const map = new Map<string, { tokens: number | null; cachePercent: number | null }>();
  for (const item of telemetryQuery.data.value?.members ?? []) {
    map.set(item.executor.memberId, {
      tokens: numeric(item.totals.totalTokens),
      cachePercent: ratioPercent(item.totals.cacheReadRatio),
    });
  }
  return map;
});

function memberSessionId(memberId: string): string {
  const candidates = props.endpoints.filter((endpoint) => endpoint.member_id === memberId);
  const coordination = candidates.find(
    (endpoint) => endpoint.context === 'coordination' || endpoint.context === 'panel-coordination',
  );
  if (coordination) return coordination.id;
  const nonProfile = candidates.find((endpoint) => endpoint.context !== 'profile');
  return nonProfile?.id ?? candidates[0]?.id ?? '';
}

function modelSummary(member: Member): string {
  const model = `${member.model_provider ? `${member.model_provider}/` : ''}${member.model ?? '默认模型'}`;
  return member.reasoning_effort ? `${model} · ${member.reasoning_effort}` : model;
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3" data-testid="team-members-panel">
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
        团队成员（{{ members.length }}）
      </h3>
    </div>

    <PanelState v-if="!members.length" :icon="Users" title="暂无成员" />

    <div v-else class="flex min-w-0 flex-col gap-2.5">
      <SectionBlock
        v-for="member in members"
        :key="member.id"
        :container="false"
        class="gap-2 p-3"
        :data-testid="`member-card-${member.id}`"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-1.5">
          <h4 class="min-w-0 truncate text-sm font-semibold text-foreground" :title="member.name">
            {{ member.name }}
          </h4>
          <Badge variant="secondary" size="xs" class="shrink-0 font-mono">
            {{ member.host }}
          </Badge>
          <Badge
            v-if="member.role === 'lead' && member.name !== '主 Agent'"
            variant="outline"
            class="shrink-0"
          >
            主 Agent
          </Badge>
          <Badge
            v-if="pausedMemberIds?.has(member.id)"
            variant="outline"
            class="ms-auto shrink-0"
          >
            原主 Agent · 暂停
          </Badge>
          <Badge
            v-else-if="runningMemberIds.has(member.id)"
            variant="secondary"
            class="ms-auto shrink-0"
          >
            <Radio />运行中
          </Badge>
        </div>

        <p class="truncate text-xs text-muted-foreground" :title="modelSummary(member)">
          {{ modelSummary(member) }}
        </p>

        <ExpandableText
          v-if="member.profile"
          class="text-xs text-muted-foreground"
          :lines="2"
          :text="member.profile"
        />

        <div class="flex items-center gap-2">
          <button
            v-if="telemetryByMember.get(member.id)?.tokens != null"
            type="button"
            class="inline-flex items-center gap-2 rounded-(--component-chip-radius) border border-border bg-muted/40 px-2 py-1 text-xs text-foreground tabular-nums transition-colors hover:bg-accent"
            :aria-label="`查看 ${member.name} 的完整用量`"
            title="在「协调遥测」中查看完整用量"
            @click="emit('openUsage', member.id)"
          >
            <span class="inline-flex items-center gap-1">
              <Coins class="size-3.5 text-muted-foreground" aria-hidden="true" />
              {{ compactNumber(telemetryByMember.get(member.id)?.tokens ?? null) }}
            </span>
            <span
              v-if="telemetryByMember.get(member.id)?.cachePercent != null"
              class="inline-flex items-center gap-1"
            >
              <Database class="size-3.5 text-muted-foreground" aria-hidden="true" />
              {{ telemetryByMember.get(member.id)!.cachePercent!.toFixed(1) }}%
            </span>
          </button>
          <span v-else class="text-xs text-muted-foreground">暂无用量观测</span>
        </div>

        <div class="flex flex-wrap items-center justify-end gap-2 pt-0.5">
          <Button
            variant="outline"
            size="xs"
            :aria-label="`调整 ${member.name} 的模型`"
            @click="emit('editModel', member)"
          >
            调整模型
          </Button>
          <Button
            variant="outline"
            size="xs"
            :disabled="!memberSessionId(member.id)"
            :aria-label="`查看 ${member.name} 的执行轨迹`"
            @click="emit('openTrace', memberSessionId(member.id))"
          >
            查看轨迹
          </Button>
        </div>
      </SectionBlock>
    </div>
  </div>
</template>
