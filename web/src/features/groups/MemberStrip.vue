<script setup lang="ts">
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardAction } from '@/components/ui/card';
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
  <div v-else class="flex flex-col gap-3">
    <Card
      v-for="member in members"
      :key="member.id"
      size="compact"
    >
      <CardHeader>
      <div class="flex min-w-0 items-start gap-3">
      <div
        ><Avatar
          ><AvatarFallback>{{
            member.name.slice(0, 1)
          }}</AvatarFallback></Avatar
        ></div
      >
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <CardTitle>{{ member.name }}<Badge v-if="member.role === 'lead' && member.name !== '主 Agent'" variant="outline">主 Agent</Badge></CardTitle>
        <CardDescription
          >{{ member.host }} ·
          {{ member.model_provider ? `${member.model_provider}/` : ''
          }}{{ member.model ?? '默认模型' }}</CardDescription
        >
        <CardDescription v-if="member.reasoning_effort"
          >思考强度 · {{ member.reasoning_effort }}</CardDescription
        >
      </div>
      <div
        class="flex flex-col items-end gap-2"
        v-if="
          pausedMemberIds?.has(member.id) || runningMemberIds.has(member.id)
        "
      >
        <Badge v-if="pausedMemberIds?.has(member.id)" variant="outline"
          >原主 Agent · 暂停</Badge
        >
        <Badge v-else-if="runningMemberIds.has(member.id)" variant="secondary"
          ><Radio />运行中</Badge
        >
      </div>
      <CardAction>
      <Button
        variant="ghost"
        size="icon-xs"
        class="self-start"
        :aria-label="`调整 ${member.name} 的模型`"
        title="调整模型与思考强度"
        @click="emit('editModel', member)"
      >
        <SlidersVertical />
      </Button>
      </CardAction>
      </div>
      </CardHeader>
      <CardContent v-if="member.profile">
        <ExpandableText
          v-if="member.profile"
          class="mt-2 text-sm text-muted-foreground"
          :lines="3"
          :text="member.profile"
        />
      </CardContent>
    </Card>
  </div>
</template>
