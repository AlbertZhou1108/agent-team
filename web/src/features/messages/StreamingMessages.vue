<script setup lang="ts">
import { computed, ref } from 'vue';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import ReasoningBlock from '@/components/ai-elements/ReasoningBlock.vue';
import LoadingDots from '@/components/ai-elements/LoadingDots.vue';
import { identityColor } from './identity';
import type { StreamView } from './adapters';

/**
 * 流式输出区。宿主以 token 级频率推送增量时,只有这个组件重渲染:
 * 读取流的动作发生在 source 内部,响应式依赖登记在这里,已定稿消息与
 * 消息列表组件都不参与,历史消息再多也不会随每个增量重画。
 */
const props = defineProps<{
  source: () => StreamView[];
  markdown?: boolean;
}>();

const views = computed(() => props.source());
const selectedStreamId = ref<string | null>(null);
const pending = computed(() => views.value.filter(item => item.pending));
// 单流自动展开(保持单人场景的既有体验);多流时只显示紧凑 chips,
// 由用户点选关注哪一路,避免多路输出在底部交替增长。
const expanded = computed<StreamView | null>(() => {
  if (!views.value.length) return null;
  const selected = views.value.find(item => item.message.id === selectedStreamId.value);
  if (selected) return selected;
  return views.value.length === 1 ? views.value[0]! : null;
});
function selectStream(id: string) {
  selectedStreamId.value = selectedStreamId.value === id ? null : id;
}
function status(item: StreamView) {
  return item.message.text ? '输出中' : '思考中';
}
</script>

<template>
  <div v-if="pending.length" class="speaking-strip" aria-live="polite" data-testid="speaking-strip">
    <span class="text-xs font-medium text-muted-foreground">正在发言</span>
    <button
      v-for="item in pending"
      :key="item.message.id"
      type="button"
      class="speaking-chip"
      :class="{ 'speaking-chip-active': expanded?.message.id === item.message.id }"
      :aria-pressed="expanded?.message.id === item.message.id"
      @click="selectStream(item.message.id)"
    >
      <span class="speaking-dot" :style="{ backgroundColor: identityColor(item.message.senderName) }" />
      <span class="max-w-32 truncate">{{ item.message.senderName }}</span>
      <span class="text-muted-foreground">{{ status(item) }}</span>
      <LoadingDots v-if="item.pending && !item.message.text" />
    </button>
  </div>
  <div
    v-if="expanded"
    :key="expanded.message.id"
    class="chat-message"
    :data-message-id="expanded.message.id"
    aria-live="polite"
  >
    <ReasoningBlock
      :reasoning="expanded.reasoning"
      :running="expanded.pending && !expanded.message.text"
      :sender="expanded.message.senderName"
      class="mb-2"
    />
    <AgentMessage :message="expanded.message" :pending="expanded.pending" :markdown="markdown">
      <template v-if="$slots.footer" #footer="{ message: footerMessage }">
        <slot name="footer" :message="footerMessage" />
      </template>
    </AgentMessage>
  </div>
</template>
