<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import MessageComposer from '@/components/ai-elements/MessageComposer.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useTeamDirectiveStore } from '@/stores/team-directives';
const props = defineProps<{
  groupId: string;
  controllerId?: string;
  archived?: boolean;
  /** 当前看到的不是主 Agent 统一调度时，明确提示发送仍会交回主调度。 */
  inCoordination?: boolean;
  activeSessionLabel?: string;
  mentions?: Array<{ id: string; name: string; role?: string }>;
}>();
const placeholder = computed(() =>
  props.inCoordination
    ? `查看「${props.activeSessionLabel ?? '成员会话'}」中；在此发送指令将交给主 Agent 并切回主调度…`
    : '向主 Agent 发送团队指令或追问…',
);
let mounted = true;
onBeforeUnmount(() => { mounted = false; });
const emit = defineEmits<{ sent: [] }>();
const store = useTeamDirectiveStore();
const client = useQueryClient();
const entry = computed(() => store.entry(props.groupId));
const draft = computed({ get: () => entry.value.draft, set: text => store.setDraft(props.groupId, text) });
async function send() {
  if (props.archived || !props.controllerId) return;
  const groupId = props.groupId;
  const result = await store.send(groupId, props.controllerId);
  if (!result) return;
  void client.invalidateQueries({ queryKey: ['group', groupId] });
  void client.invalidateQueries({ queryKey: ['home-summary'] });
  void client.invalidateQueries({ queryKey: ['panel-agent'] });
  void client.invalidateQueries({ queryKey: ['messages', groupId] });
  void client.invalidateQueries({ queryKey: ['team-directives', groupId] });
  if (mounted) emit('sent');
}
</script>
<template>
  <div class="flex flex-col gap-2">
    <!-- 每条消息的投递回执已由消息流 MessageReceipt 承担，输入区只保留真正阻塞发送的归档提示与失败告警。 -->
    <p
      v-if="archived"
      class="px-4 pt-2 text-xs text-muted-foreground"
      aria-live="polite"
    >团队已归档，不能发送消息。</p>
    <Alert v-if="entry.error" variant="destructive" class="mx-4 w-auto">
      <AlertDescription class="flex items-center gap-2">
        <span class="flex-1">{{ entry.error }}</span>
        <Button size="sm" variant="outline" :disabled="entry.sending || archived || !controllerId" @click="send">重试发送</Button>
      </AlertDescription>
    </Alert>
    <MessageComposer v-model="draft" label="发送给主 Agent" :placeholder="placeholder" :mentions="mentions"
      :sending="entry.sending" :disabled="archived || !controllerId" @submit="send" />
  </div>
</template>
