<script setup lang="ts">
import { computed } from 'vue';
import { Check, Copy } from '@lucide/vue';
import { useClipboard } from '@vueuse/core';
import ConversationMessage from '@/components/ai-elements/ConversationMessage.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MessageFooter } from '@/components/ui/message';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { PanelMessage } from '@/shared/api/raw-types';
import type { PanelTeam } from './types';

const props = defineProps<{
  message: PanelMessage;
  teams: PanelTeam[];
  pending?: boolean;
}>();

const { copy, copied } = useClipboard({ copiedDuring: 1500, legacy: true });
const teamName = computed(
  () =>
    props.teams.find((team) => team.id === props.message.active_team_id)
      ?.name ?? props.message.active_team_id,
);
const time = computed(() =>
  new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(props.message.created)),
);
</script>

<template>
  <ConversationMessage :role="message.role" :content="message.text" :pending="props.pending">
    <template #footer>
      <MessageFooter class="agent-ai-message-footer flex-wrap gap-2">
        <time :datetime="message.created" :title="new Date(message.created).toLocaleString('zh-CN')">{{ time }}</time>
        <Badge v-if="message.role === 'system'" variant="default"
          >自动进度</Badge
        >
        <Badge v-if="teamName" variant="secondary" class="max-w-full"><span class="truncate" :title="teamName">{{ teamName }}</span></Badge>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-xs"
              :aria-label="copied ? '已复制' : '复制消息'"
              @click="copy(message.text)"
            >
              <Check v-if="copied" data-icon />
              <Copy v-else data-icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ copied ? '已复制' : '复制消息' }}</TooltipContent>
        </Tooltip>
      </MessageFooter>
    </template>
  </ConversationMessage>
</template>
