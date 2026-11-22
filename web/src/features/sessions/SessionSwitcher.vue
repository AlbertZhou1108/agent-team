<script setup lang="ts">
import { computed } from 'vue';
import { Check, ChevronDown, Radio } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Member, SessionEndpoint } from '@/shared/api/raw-types';

/**
 * 中间主区标签栏右侧的内联会话下拉切换器。
 * 替代原右侧栏独立的「会话」标签页，切换会话无需跨 tab 跳转。
 */
const props = defineProps<{
  endpoints: SessionEndpoint[];
  members: Member[];
  actors?: Array<{ id: string; name: string; host?: string }>;
  selectedId?: string;
  runningEndpoints: string[];
  allowAll?: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
}>();

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

function memberName(id: string) {
  if (id === 'user') return '用户';
  return (
    props.members.find((member) => member.id === id)?.name ??
    props.actors?.find((actor) => actor.id === id)?.name ??
    id
  );
}

function contextLabel(endpoint: SessionEndpoint) {
  if (endpoint.context === 'panel-coordination') return 'Panel Agent 主控';
  if (endpoint.context === 'coordination') return '统一调度';
  return endpoint.peer ? `与 ${memberName(endpoint.peer)}` : '入群自述';
}

function endpointLabel(endpoint: SessionEndpoint) {
  return `${memberName(endpoint.member_id)} · ${contextLabel(endpoint)}`;
}

function isSelected(endpoint: SessionEndpoint) {
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

const currentLabel = computed(() => {
  const active = props.endpoints.find((item) => item.id === props.selectedId);
  if (active) return endpointLabel(active);
  return props.allowAll ? '全部群消息' : '选择会话';
});
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="outline"
        size="xs"
        class="max-w-56 justify-between gap-1.5 font-normal"
        aria-label="切换会话"
        data-testid="inline-session-switcher"
      >
        <span class="truncate">{{ currentLabel }}</span>
        <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-64">
      <DropdownMenuGroup>
        <DropdownMenuItem
          v-if="allowAll"
          class="flex items-center justify-between gap-2"
          @select="emit('select', '')"
        >
          <span class="truncate">全部群消息</span>
          <Check v-if="!selectedId" class="size-3.5 shrink-0 text-primary" />
        </DropdownMenuItem>
        <DropdownMenuItem
          v-for="endpoint in conversations"
          :key="endpoint.id"
          class="flex items-center justify-between gap-2"
          @select="emit('select', endpoint.id)"
        >
          <span class="flex min-w-0 items-center gap-1.5 truncate">
            <Radio
              v-if="runningEndpoints.includes(endpoint.id)"
              class="size-3 shrink-0 text-success"
              aria-hidden="true"
            />
            <span class="truncate">{{ endpointLabel(endpoint) }}</span>
          </span>
          <Check v-if="isSelected(endpoint)" class="size-3.5 shrink-0 text-primary" />
        </DropdownMenuItem>
        <div
          v-if="!allowAll && !conversations.length"
          class="px-2 py-1.5 text-xs text-muted-foreground"
        >
          暂无可查看的会话
        </div>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
