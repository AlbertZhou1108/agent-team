<script setup lang="ts">
import { computed } from 'vue';
import { Bot, Radio } from '@lucide/vue';
import type { Member, SessionBinding, SessionEndpoint } from '@/shared/api/raw-types';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const props = defineProps<{
  endpoints: SessionEndpoint[];
  sessionBindings: SessionBinding[];
  members: Member[];
  actors?: Array<{
    id: string;
    name: string;
    host?: string;
    model_provider?: string | null;
    model?: string | null;
    reasoning_effort?: string | null;
  }>;
  selectedId?: string;
  runningEndpoints: string[];
}>();

const emit = defineEmits<{ select: [id: string] }>();

const conversations = computed(() => {
  const seen = new Set<string>();
  return props.endpoints.filter(endpoint => {
    if (endpoint.context === 'profile') return false;
    const key = endpoint.peer ? [endpoint.member_id, endpoint.peer].sort().join(':') : endpoint.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});
function selected(endpoint: SessionEndpoint) {
  const active = props.endpoints.find(item => item.id === props.selectedId);
  return endpoint.id === props.selectedId || Boolean(endpoint.peer && active?.peer &&
    [endpoint.member_id, endpoint.peer].sort().join(':') === [active.member_id, active.peer].sort().join(':'));
}

function memberName(id: string) {
  return props.members.find(member => member.id === id)?.name
    ?? props.actors?.find(actor => actor.id === id)?.name
    ?? id;
}
function configuredModel(id: string) {
  const member = props.members.find(item => item.id === id);
  const actor = props.actors?.find(item => item.id === id);
  const configured = member?.model ? member : actor;
  if (!configured?.model) return null;
  return `${configured.model_provider ? `${configured.model_provider}/` : ''}${configured.model} · ${configured.reasoning_effort ?? '默认强度'}`;
}
function domains(endpointId: string) {
  return props.sessionBindings
    .filter(binding => binding.endpoint_id === endpointId && binding.session_key !== 'default')
    .map(binding => binding.session_key);
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
  <div class="flex flex-col gap-1.5">
    <button type="button" :class="cn('session-item', !selectedId && 'session-item-active')" :aria-pressed="!selectedId" @click="emit('select', '')">
      <span class="session-icon"><Bot :size="14" /></span>
      <span class="text-xs font-medium">全部群消息</span>
    </button>
    <button
      v-for="endpoint in conversations"
      :key="endpoint.id"
      :aria-pressed="selected(endpoint)"
      type="button"
      :class="cn('session-item', selected(endpoint) && 'session-item-active')"
      @click="emit('select', endpoint.id)"
    >
      <span class="session-icon">
        <Bot :size="14" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-left text-xs font-medium">
          {{ memberName(endpoint.member_id) }}
          <span class="font-normal text-dim">· {{ contextLabel(endpoint) }}</span>
        </span>
        <span class="mt-1 block truncate text-left font-mono text-[9px] text-dim">
          <template v-if="endpoint.modelState.currentModel?.model">
            {{ endpoint.modelState.currentModel.model }}
            · {{ endpoint.modelState.currentReasoningEffort?.reasoningEffort ?? '强度未知' }}
          </template>
          <template v-else>
            {{ configuredModel(endpoint.member_id) ?? '模型未知' }}
          </template>
        </span>
        <span v-if="domains(endpoint.id).length" class="mt-1 flex flex-wrap gap-1">
          <Badge v-for="domain in domains(endpoint.id)" :key="domain" variant="default">{{ domainLabel(domain) }}</Badge>
        </span>
      </span>
      <Badge v-if="runningEndpoints.includes(endpoint.id)" variant="accent">
        <Radio :size="9" class="animate-pulse" />
        运行
      </Badge>
    </button>
    <div v-if="!conversations.length" class="empty-state compact">这个群还没有宿主会话。</div>
  </div>
</template>
