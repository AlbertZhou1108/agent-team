<script setup lang="ts">
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import ExpandableText from '@/components/ai-elements/ExpandableText.vue';
import { Radio, SlidersVertical, Users } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import type { Member } from '@/shared/api/raw-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

defineProps<{
  members: Member[];
  runningMemberIds: Set<string>;
  pausedMemberIds?: Set<string>;
}>();
const emit = defineEmits<{
  editModel: [member: Member];
}>();
</script>

<template>
  <PanelState v-if="!members.length" :icon="Users" title="暂无成员" />
  <div v-else class="flex flex-col divide-y divide-border">
    <!-- 成员列表活在带边框的上下文面板里,行与行之间只留分割线。 -->
    <section
      v-for="member in members"
      :key="member.id"
      class="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0"
    >
      <div class="flex min-w-0 items-start gap-3">
        <Avatar>
          <AvatarFallback>{{ member.name.slice(0, 1) }}</AvatarFallback>
        </Avatar>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <h4 class="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-semibold">
            <span class="min-w-0 truncate" :title="member.name">{{ member.name }}</span>
            <Badge
              v-if="member.role === 'lead' && member.name !== '主 Agent'"
              variant="outline"
              >主 Agent</Badge
            >
          </h4>
          <p class="text-xs text-muted-foreground">
            {{ member.host }} ·
            {{ member.model_provider ? `${member.model_provider}/` : '' }}{{
              member.model ?? '默认模型'
            }}
          </p>
          <p v-if="member.reasoning_effort" class="text-xs text-muted-foreground">
            思考强度 · {{ member.reasoning_effort }}
          </p>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-2">
          <Badge v-if="pausedMemberIds?.has(member.id)" variant="outline"
            >原主 Agent · 暂停</Badge
          >
          <Badge v-else-if="runningMemberIds.has(member.id)" variant="secondary"
            ><Radio />运行中</Badge
          >
          <Button
            variant="ghost"
            size="icon-xs"
            :aria-label="`调整 ${member.name} 的模型`"
            title="调整模型与思考强度"
            @click="emit('editModel', member)"
          >
            <SlidersVertical />
          </Button>
        </div>
      </div>
      <ExpandableText
        v-if="member.profile"
        class="text-sm text-muted-foreground"
        :lines="3"
        :text="member.profile"
      />
    </section>
  </div>
</template>
