<script setup lang="ts">
import { Bot, Radio } from '@lucide/vue';
import type { Member, SessionBinding, SessionEndpoint } from '@/shared/api/raw-types';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const props = defineProps<{
  endpoints: SessionEndpoint[];
  sessionBindings: SessionBinding[];
  members: Member[];
  selectedId?: string;
  runningEndpoints: string[];
}>();

const emit = defineEmits<{ select: [id: string] }>();

function memberName(id: string) {
  return props.members.find(member => member.id === id)?.name ?? id;
}
function configuredModel(id: string) {
  const member = props.members.find(item => item.id === id);
  if (!member?.model) return null;
  return `${member.model_provider ? `${member.model_provider}/` : ''}${member.model} · ${member.reasoning_effort ?? '默认强度'}`;
}
function domains(endpointId: string) {
  return props.sessionBindings
    .filter(binding => binding.endpoint_id === endpointId)
    .map(binding => binding.session_key);
}
function domainLabel(domain: string) {
  if (domain === 'default') return '统一会话';
  if (domain === 'communication') return '沟通';
  if (domain === 'project') return '项目';
  return domain;
}
</script>

<template>
  <div class="space-y-1.5">
    <button
      v-for="endpoint in endpoints"
      :key="endpoint.id"
      type="button"
      :class="cn('session-item', endpoint.id === selectedId && 'session-item-active')"
      @click="emit('select', endpoint.id)"
    >
      <span class="session-icon">
        <Bot :size="14" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-left text-xs font-medium">
          {{ memberName(endpoint.member_id) }}
          <span class="font-normal text-dim">· {{ endpoint.context === 'coordination' ? '统一调度' : endpoint.peer ? `与 ${memberName(endpoint.peer)}` : '入群自述' }}</span>
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
    <div v-if="!endpoints.length" class="empty-state compact">这个群还没有宿主会话。</div>
  </div>
</template>
