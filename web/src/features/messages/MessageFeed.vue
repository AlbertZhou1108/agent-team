<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import PanelState from '@/components/panel/PanelState.vue';
import { LoaderCircle, MessagesSquare } from '@lucide/vue';
import type { MessageView } from '@/shared/models/view-types';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import ConversationPanel from '@/components/ai-elements/ConversationPanel.vue';
import MessageTrace from '@/components/ai-elements/MessageTrace.vue';
import RunStatusCard from '@/components/ai-elements/RunStatusCard.vue';
import { Badge } from '@/components/ui/badge';
import type { Interaction, TeamDirectiveReceipt } from '@/shared/api/raw-types';
import { directiveStatus } from './directive-status';
import type { StreamView } from './adapters';
import { buildMessageGroups, isSystemStack } from './message-groups';
import { Button } from '@/components/ui/button';
import InteractionCard from './InteractionCard.vue';
import StreamingMessages from './StreamingMessages.vue';

const props = withDefaults(
  defineProps<{
    messages: MessageView[];
    /**
     * 流视图的取值函数,是流数据的唯一入口。高频更新必须走取值函数而不是数组
     * props:函数只在 StreamingMessages 内部被调用,响应式依赖登记在流式子组件上,
     * 本组件不会随每个增量重渲染。
     */
    streamSource?: () => StreamView[];
    directives?: TeamDirectiveReceipt[];
    interactions?: Interaction[];
    title?: string;
    selectedPair: string;
    hosts?: Record<string, string>;
    /** 团队 id → 名称,仅用于运行卡里的工具动作说明。 */
    groupNames?: Record<string, string>;
    loading?: boolean;
    hasNextPage?: boolean;
    fetchingNextPage?: boolean;
    /** 连续 system 消息是否折叠为通知堆栈;Panel 的自动进度消息不折叠。 */
    groupSystemMessages?: boolean;
    /** 助手/系统正文按 Markdown 渲染。 */
    markdown?: boolean;
    ariaLabel?: string;
    resetKey?: string | number;
    viewportClass?: string;
    streamClass?: string;
    contentClass?: string;
  }>(),
  {
    streamSource: undefined,
    directives: () => [],
    interactions: () => [],
    title: undefined,
    hosts: () => ({}),
    groupNames: () => ({}),
    loading: false,
    hasNextPage: false,
    fetchingNextPage: false,
    groupSystemMessages: true,
    markdown: false,
    ariaLabel: '团队消息',
    resetKey: undefined,
    viewportClass: 'message-viewport',
    streamClass: 'message-stream',
    contentClass: 'message-content',
  },
);

const emit = defineEmits<{
  loadMore: [];
}>();

// 多路并发时由运行卡决定展示哪一路正文;切换会话时清空选择。
const selectedRunKey = ref<string | null>(null);
watch(
  () => props.resetKey ?? props.selectedPair,
  () => { selectedRunKey.value = null; },
);

const filtered = computed(() =>
  props.selectedPair
    ? props.messages.filter((message) => message.pairKey === props.selectedPair)
    : props.messages,
);
// 稳定取值函数:setup 内定义一次,子组件拿到的一直是同一引用。
const readStreamViews = (): StreamView[] => props.streamSource?.() ?? [];
const streamingViews = computed(readStreamViews);
// 只统计条数而不在模板里读取数组本身:数组每个增量都换新引用,而 computed 只在
// 数值真正变化时才通知依赖,本组件因此不会随每个 token 进入渲染。
const streamingCount = computed(() => streamingViews.value.length);

const messageGroups = computed(() =>
  buildMessageGroups(filtered.value, { groupSystemMessages: props.groupSystemMessages }),
);
// 统一为「堆栈 | 群发 | 消息序列」形态,run/single 走同一渲染路径。
const renderGroups = computed(() =>
  messageGroups.value.map(group => ({
    id: group.id,
    stack: group.kind === 'system' && isSystemStack(group),
    fanout: group.kind === 'fanout',
    messages: group.kind === 'single' ? [group.message] : group.messages,
  })),
);
const receipts = computed(() => Object.fromEntries((props.directives ?? []).map(r => [r.messageId, r])));
const messageInteractions = computed(() => {
  const map: Record<string, Interaction[]> = {};
  for (const item of props.interactions ?? []) {
    if (!item.message_id) continue;
    (map[item.message_id] ??= []).push(item);
  }
  return map;
});
// ids 身份保持:元素集合没变时不产出新数组,避免滚动容器在每个增量
// 都重跑跟底逻辑(每次都要读 scrollHeight,强制同步布局)。
let previousIds: string[] = [];
const messageIds = computed(() => {
  const next = [
    ...filtered.value.map((message) => message.id),
    ...streamingViews.value.map((item) => item.message.id),
  ];
  if (
    previousIds.length === next.length &&
    previousIds.every((id, index) => id === next[index])
  ) {
    return previousIds;
  }
  previousIds = next;
  return next;
});
</script>

<template>
  <ConversationPanel
    class="message-feed min-w-0"
    :ids="messageIds"
    :reset-key="resetKey ?? selectedPair"
    :aria-label="ariaLabel"
    :viewport-class="viewportClass"
    :stream-class="streamClass"
    :content-class="contentClass"
  >
    <template v-if="$slots.header" #header>
      <slot name="header" />
    </template>
    <template v-else #header>
      <div class="message-toolbar justify-between">
        <h3 class="truncate text-sm font-medium">
          {{ title ?? '全部群消息' }}
        </h3>
        <span class="text-xs text-muted-foreground tabular-nums"
          >{{ filtered.length + streamingCount }} 条消息</span
        >
      </div>
    </template>
    <div v-if="hasNextPage" class="flex justify-center py-2">
      <Button variant="outline" size="sm" :disabled="fetchingNextPage" @click="emit('loadMore')">
        <LoaderCircle v-if="fetchingNextPage" class="animate-spin" />
        {{ fetchingNextPage ? '正在加载' : '加载更早消息' }}
      </Button>
    </div>
    <div v-for="group in renderGroups" :key="group.id" class="chat-message">
      <details v-if="group.stack" class="notification-stack">
        <summary>
          <span class="font-medium"
            >系统通知
            <span class="text-xs text-muted-foreground"
              >{{ group.messages.length }} 条</span
            ></span
          >
          <span class="notification-expand text-xs text-muted-foreground"
            >展开</span
          >
          <span class="notification-collapse text-xs text-muted-foreground"
            >收起</span
          >
        </summary>
        <div class="flex flex-col gap-2 p-3">
          <AgentMessage
            v-for="message in group.messages"
            :key="message.id"
            :message="message"
          />
        </div>
      </details>
      <template v-else-if="group.fanout">
        <MessageTrace
          :message-id="group.messages[0]!.id"
          :hosts="hosts ?? {}"
        />
        <!-- 相同指令群发:正文展示一次,头部列出全部接收者;逐条保留锚点与回执 -->
        <div
          v-for="(message, index) in group.messages"
          :key="message.id"
          :data-message-id="message.id"
        >
          <AgentMessage
            v-if="index === 0"
            :message="message"
            :fanout-recipients="group.messages.map(item => item.recipientName)"
            :markdown="markdown"
          >
            <template v-if="$slots.footer" #footer="{ message }">
              <slot name="footer" :message="message" />
            </template>
          </AgentMessage>
          <p
            v-else
            class="sr-only"
            aria-hidden="true"
          >{{ message.senderName }} → {{ message.recipientName }}：{{ message.text }}</p>
          <InteractionCard
            v-for="interaction in messageInteractions[message.id] ?? []"
            :key="interaction.id"
            :interaction="interaction"
            class="mt-2"
          />
          <p v-if="receipts[message.id]" class="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            <Badge variant="outline">{{ directiveStatus(receipts[message.id]!) }}</Badge>
            <span v-if="receipts[message.id]!.error">{{ receipts[message.id]!.error }}</span>
          </p>
        </div>
      </template>
      <template v-else>
        <MessageTrace
          v-if="!group.messages[0]!.senderIsUser"
          :message-id="group.messages[0]!.id"
          :hosts="hosts ?? {}"
        />
        <!-- 每条消息保留独立锚点;同发送者连续消息仅首条显示身份 -->
        <div
          v-for="(message, index) in group.messages"
          :key="message.id"
          :data-message-id="message.id"
        >
          <AgentMessage :message="message" :compact="index > 0" :markdown="markdown">
            <template v-if="$slots.footer" #footer="{ message }">
              <slot name="footer" :message="message" />
            </template>
          </AgentMessage>
          <InteractionCard
            v-for="interaction in messageInteractions[message.id] ?? []"
            :key="interaction.id"
            :interaction="interaction"
            class="mt-2"
          />
          <p v-if="receipts[message.id]" class="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            <Badge variant="outline">{{ directiveStatus(receipts[message.id]!) }}</Badge>
            <span v-if="receipts[message.id]!.error">{{ receipts[message.id]!.error }}</span>
          </p>
        </div>
      </template>
    </div>
    <!-- 正在发言:独立组件读取流数据,已定稿消息不随每个增量重渲染。 -->
    <StreamingMessages :source="readStreamViews" :markdown="markdown" :selected-turn-key="selectedRunKey">
      <template v-if="$slots.footer" #footer="{ message }">
        <slot name="footer" :message="message" />
      </template>
    </StreamingMessages>
    <PanelState v-if="loading" loading title="正在读取群消息" />
    <slot v-else-if="!filtered.length && !streamingCount" name="empty">
      <PanelState :icon="MessagesSquare" title="暂无消息" />
    </slot>

    <!-- 运行状态固定在手风琴之外:它汇总过程,不参与消息滚动。 -->
    <template #footer>
      <RunStatusCard
        :source="readStreamViews"
        :selected-key="selectedRunKey"
        :group-names="groupNames"
        @select="selectedRunKey = $event"
      />
    </template>
  </ConversationPanel>
</template>
