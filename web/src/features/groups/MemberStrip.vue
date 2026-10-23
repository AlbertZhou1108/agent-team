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
import { Radio, Users } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import type { Member } from '@/shared/api/raw-types';
import { Badge } from '@/components/ui/badge';

defineProps<{
  members: Member[];
  runningMemberIds: Set<string>;
  pausedMemberIds?: Set<string>;
}>();
</script>

<template>
  <PanelState v-if="!members.length" :icon="Users" title="暂无成员" description="成员加入团队后，会显示身份、模型和能力自述。" />
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
        v-if="
          pausedMemberIds?.has(member.id) || runningMemberIds.has(member.id)
        "
        class="w-full"
      >
        <Badge v-if="pausedMemberIds?.has(member.id)" variant="outline"
          >原主 Agent · 暂停</Badge
        >
        <Badge v-else-if="runningMemberIds.has(member.id)" variant="secondary"
          ><Radio />运行中</Badge
        >
      </div>
    </Item>
  </ItemGroup>
</template>
