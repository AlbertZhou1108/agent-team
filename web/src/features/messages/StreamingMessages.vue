<script setup lang="ts">
import { computed } from 'vue';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import type { StreamView } from './adapters';

/**
 * 流式正文区。运行状态(阶段、计时、思考)由 RunStatusCard 统一承载,这里只渲染
 * 已产生的正文,避免同一份过程在两处重复展示。
 * 宿主以 token 级频率推送增量时,只有这个组件重渲染:读取流的动作发生在 source
 * 内部,响应式依赖登记在这里,已定稿消息与消息列表组件都不参与。
 */
const props = defineProps<{
  source: () => StreamView[];
  markdown?: boolean;
  /** 由状态卡选中的回合;缺省时展示第一路,与卡片默认高亮保持一致。 */
  selectedTurnKey?: string | null;
}>();

const views = computed(() => props.source());
const body = computed(() => views.value.filter(view => view.message.text.trim()));
const visible = computed<StreamView | null>(() => {
  if (!body.value.length) return null;
  const selected = props.selectedTurnKey
    ? body.value.find(view => (view.turnId ?? view.message.id) === props.selectedTurnKey)
    : null;
  return selected ?? body.value[0]!;
});
</script>

<template>
  <div
    v-if="visible"
    :key="visible.message.id"
    class="chat-message"
    :data-message-id="visible.message.id"
    aria-live="polite"
  >
    <AgentMessage :message="visible.message" :pending="visible.pending" :markdown="markdown">
      <template v-if="$slots.footer" #footer="{ message: footerMessage }">
        <slot name="footer" :message="footerMessage" />
      </template>
    </AgentMessage>
  </div>
</template>
