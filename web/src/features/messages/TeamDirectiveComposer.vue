<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import MessageComposer from '@/components/ai-elements/MessageComposer.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTeamDirectiveStore } from '@/stores/team-directives';
import type { TeamDirectiveReceipt } from '@/shared/api/raw-types';
import { directiveStatus } from './directive-status';
const props = defineProps<{ groupId: string; controllerId?: string; archived?: boolean; receipts: TeamDirectiveReceipt[] }>();
let mounted = true;
onBeforeUnmount(() => { mounted = false; });
const emit = defineEmits<{ sent: [] }>();
const store = useTeamDirectiveStore();
const client = useQueryClient();
const entry = computed(() => store.entry(props.groupId));
const draft = computed({ get: () => entry.value.draft, set: text => store.setDraft(props.groupId, text) });
const latest = computed(() => props.receipts.find(r => r.messageId === entry.value.receipt?.messageId) ?? entry.value.receipt);
async function send() {
  if (props.archived || !props.controllerId) return;
  const groupId = props.groupId;
  const result = await store.send(groupId, props.controllerId);
  if (!result) return;
  void client.invalidateQueries({ queryKey: ['messages', groupId] });
  void client.invalidateQueries({ queryKey: ['team-directives', groupId] });
  if (mounted) emit('sent');
}
</script>
<template>
  <div class="flex flex-col gap-2">
    <!-- 输入区占位符已说明发送对象,这里只保留需要处理的状态。 -->
    <div
      v-if="latest || archived"
      class="flex flex-wrap items-center gap-2 px-4 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <Badge v-if="latest" variant="outline">{{ directiveStatus(latest) }}</Badge>
      <span v-if="archived">团队已归档，不能发送消息。</span>
    </div>
    <Alert v-if="entry.error" variant="destructive" class="mx-4 w-auto">
      <AlertDescription class="flex items-center gap-2">
        <span class="flex-1">{{ entry.error }}</span>
        <Button size="sm" variant="outline" :disabled="entry.sending || archived || !controllerId" @click="send">重试发送</Button>
      </AlertDescription>
    </Alert>
    <MessageComposer v-model="draft" label="发送给主 Agent" placeholder="向主 Agent 发送团队指令或追问…"
      :sending="entry.sending" :disabled="archived || !controllerId" @submit="send" />
  </div>
</template>
