<script setup lang="ts">
import {
  Item,
  ItemGroup,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from '@/components/ui/item';
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
  <ItemGroup v-else class="gap-2">
    <Item
      v-for="member in members"
      :key="member.id"
      variant="outline"
      class="items-start"
    >
      <ItemMedia
        ><Avatar
          ><AvatarFallback>{{
            member.name.slice(0, 1)
          }}</AvatarFallback></Avatar
        ></ItemMedia
      >
      <ItemContent>
        <ItemTitle>{{ member.name }}<Badge v-if="member.role === 'lead' && member.name !== '主 Agent'" variant="outline">主 Agent</Badge></ItemTitle>
        <ItemDescription
          >{{ member.host }} ·
          {{ member.model_provider ? `${member.model_provider}/` : ''
          }}{{ member.model ?? '默认模型' }}</ItemDescription
        >
        <ItemDescription v-if="member.reasoning_effort"
          >思考强度 · {{ member.reasoning_effort }}</ItemDescription
        >
        <ExpandableText
          v-if="member.profile"
          class="mt-2 text-sm text-muted-foreground"
          :lines="3"
          :text="member.profile"
        />
      </ItemContent>
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
    </Item>
  </ItemGroup>
</template>
