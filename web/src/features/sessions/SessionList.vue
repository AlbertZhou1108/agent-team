<script setup lang="ts">
import PanelState from '@/components/panel/PanelState.vue';
import {
  Item,
  ItemGroup,
  ItemMedia,
  ItemContent,
  ItemTitle,
} from '@/components/ui/item';
import { computed } from 'vue';
import { Bot, Radio } from '@lucide/vue';
import type {
  Member,
  SessionBinding,
  SessionEndpoint,
} from '@/shared/api/raw-types';
import { Badge } from '@/components/ui/badge';

const props = defineProps<{
  endpoints: SessionEndpoint[];
  sessionBindings: SessionBinding[];
  members: Member[];
  actors?: Array<{
    id: string;
    name: string;
    host?: string;
  }>;
  selectedId?: string;
  runningEndpoints: string[];
}>();

const emit = defineEmits<{ select: [id: string] }>();

const conversations = computed(() => {
  const seen = new Set<string>();
  return props.endpoints.filter((endpoint) => {
    if (endpoint.context === 'profile') return false;
    const key = endpoint.peer
      ? [endpoint.member_id, endpoint.peer].sort().join(':')
      : endpoint.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});
function selected(endpoint: SessionEndpoint) {
  const active = props.endpoints.find((item) => item.id === props.selectedId);
  return (
    endpoint.id === props.selectedId ||
    Boolean(
      endpoint.peer &&
        active?.peer &&
        [endpoint.member_id, endpoint.peer].sort().join(':') ===
          [active.member_id, active.peer].sort().join(':'),
    )
  );
}

function memberName(id: string) {
  if (id === 'user') return '用户';
  return (
    props.members.find((member) => member.id === id)?.name ??
    props.actors?.find((actor) => actor.id === id)?.name ??
    id
  );
}
function domains(endpointId: string) {
  return props.sessionBindings
    .filter(
      (binding) =>
        binding.endpoint_id === endpointId && binding.session_key !== 'default',
    )
    .map((binding) => binding.session_key);
}
function domainLabel(domain: string) {
  if (domain === 'default') return '统一会话';
  if (domain === 'communication') return '沟通';
  if (domain === 'project') return '项目';
  return domain;
}
function contextLabel(endpoint: SessionEndpoint) {
  if (endpoint.context === 'panel-coordination') return 'Panel Agent 主控';
  if (endpoint.context === 'coordination') return '统一调度';
  return endpoint.peer ? `与 ${memberName(endpoint.peer)}` : '入群自述';
}
</script>

<template>
  <ItemGroup class="gap-2">
    <Item
      as="button"
      :variant="!selectedId ? 'muted' : 'default'"
      type="button"
      class="session-item text-left"
      :aria-pressed="!selectedId"
      @click="emit('select', '')"
    >
      <ItemMedia variant="icon"><Bot /></ItemMedia>
      <ItemContent><ItemTitle>全部群消息</ItemTitle></ItemContent>
    </Item>
    <Item
      as="button"
      :variant="selected(endpoint) ? 'muted' : 'default'"
      v-for="endpoint in conversations"
      :key="endpoint.id"
      :aria-pressed="selected(endpoint)"
      type="button"
      class="session-item text-left"
      @click="emit('select', endpoint.id)"
    >
      <ItemMedia variant="icon"><Bot /></ItemMedia>
      <ItemContent>
        <ItemTitle>
          {{ memberName(endpoint.member_id) }}
          <span class="font-normal text-muted-foreground"
            >· {{ contextLabel(endpoint) }}</span
          >
        </ItemTitle>
        <span
          v-if="domains(endpoint.id).length"
          class="mt-1 flex flex-wrap gap-1"
        >
          <Badge
            v-for="domain in domains(endpoint.id)"
            :key="domain"
            variant="outline"
            >{{ domainLabel(domain) }}</Badge
          >
        </span>
      </ItemContent>
      <Badge v-if="runningEndpoints.includes(endpoint.id)" variant="default">
        <Radio class="animate-pulse" />
        运行
      </Badge>
    </Item>
    <PanelState v-if="!conversations.length" :icon="Bot" title="暂无宿主会话" description="成员执行任务后，会话会显示在这里。" />
  </ItemGroup>
</template>
