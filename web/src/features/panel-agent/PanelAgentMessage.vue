<script setup lang="ts">
import { computed } from 'vue';
import {
  Check,
  Copy,
} from '@lucide/vue';
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
}>();

const { copy, copied } = useClipboard({ copiedDuring: 1500, legacy: true });
const teamName = computed(() => (
  props.teams.find(team => team.id === props.message.active_team_id)?.name
  ?? props.message.active_team_id
));
const time = computed(() => new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}).format(new Date(props.message.created)));
</script>

<template>
  <ConversationMessage
    :role="message.role"
    :content="message.text"
  >
    <template #footer>
      <MessageFooter class="agent-ai-message-footer">
        <time>{{ time }}</time>
        <Badge v-if="message.role === 'system'" variant="accent">自动进度</Badge>
        <Badge v-if="teamName" variant="default">{{ teamName }}</Badge>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-xs"
              :aria-label="copied ? '已复制' : '复制消息'"
              @click="copy(message.text)"
            >
              <Check v-if="copied" :size="12" data-icon />
              <Copy v-else :size="12" data-icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ copied ? '已复制' : '复制消息' }}</TooltipContent>
        </Tooltip>
      </MessageFooter>
    </template>
  </ConversationMessage>
</template>
