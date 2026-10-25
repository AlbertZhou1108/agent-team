<script setup lang="ts">
import { computed, ref } from 'vue';
import PanelState from '@/components/panel/PanelState.vue';
import { LoaderCircle, MessagesSquare } from '@lucide/vue';
import type { MessageView } from '@/shared/models/view-types';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import ConversationPanel from '@/components/ai-elements/ConversationPanel.vue';
import MessageTrace from '@/components/ai-elements/MessageTrace.vue';
import ReasoningBlock from '@/components/ai-elements/ReasoningBlock.vue';
import LoadingDots from '@/components/ai-elements/LoadingDots.vue';
import { Badge } from '@/components/ui/badge';
import type { Interaction, TeamDirectiveReceipt, TeamStream } from '@/shared/api/raw-types';
import { identityColor } from './identity';
import { directiveStatus } from './directive-status';
import { toStreamMessageViews } from './adapters';
import type { StreamView } from './adapters';
import { buildMessageGroups, isSystemStack } from './message-groups';
import { Button } from '@/components/ui/button';
import InteractionCard from './InteractionCard.vue';

const props = withDefaults(
  defineProps<{
    messages: MessageView[];
    streaming?: TeamStream[];
    /** 预转换的流视图;提供时优先于 streaming 的内部转换(Panel 等非 TeamStream 数据源使用)。 */
    streamViews?: StreamView[];
    directives?: TeamDirectiveReceipt[];
    interactions?: Interaction[];
    title?: string;
    selectedPair: string;
    controllerId?: string;
    hosts?: Record<string, string>;
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
    streaming: () => [],
    streamViews: undefined,
    directives: () => [],
    interactions: () => [],
    title: undefined,
    controllerId: undefined,
    hosts: () => ({}),
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

const filtered = computed(() =>
  props.selectedPair
    ? props.messages.filter((message) => message.pairKey === props.selectedPair)
    : props.messages,
);
const streamingViews = computed<StreamView[]>(() =>
  props.streamViews
    ?? toStreamMessageViews(
      props.messages,
      props.streaming ?? [],
      props.selectedPair,
      props.controllerId,
    ),
);
const streamingMessages = computed(() =>
  streamingViews.value.map(item => item.message),
);

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
const messageIds = computed(() => [
  ...filtered.value.map((message) => message.id),
  ...streamingMessages.value.map((message) => message.id),
]);

// 正在发言面板:单流自动展开(保持单人场景的既有体验),多流时只显示
// 紧凑 chips,由用户点选关注哪一路,避免多路输出在底部交替增长。
const selectedStreamId = ref<string | null>(null);
const speakingStrip = computed(() => streamingViews.value.filter(item => item.pending));
const expandedStream = computed<StreamView | null>(() => {
  if (!streamingViews.value.length) return null;
  const selected = streamingViews.value.find(item => item.message.id === selectedStreamId.value);
  if (selected) return selected;
  return streamingViews.value.length === 1 ? streamingViews.value[0]! : null;
});
function selectStream(id: string) {
  selectedStreamId.value = selectedStreamId.value === id ? null : id;
}
function stripStatus(item: StreamView) {
  return item.message.text ? '输出中' : '思考中';
}
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
          >{{ filtered.length + streamingMessages.length }} 条消息</span
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
    <!-- 正在发言面板:选中的流展开显示,其余以 chips 呈现,粘底不与定稿消息混排 -->
    <div v-if="speakingStrip.length" class="speaking-strip" aria-live="polite" data-testid="speaking-strip">
      <span class="text-xs font-medium text-muted-foreground">正在发言</span>
      <button
        v-for="item in speakingStrip"
        :key="item.message.id"
        type="button"
        class="speaking-chip"
        :class="{ 'speaking-chip-active': expandedStream?.message.id === item.message.id }"
        :aria-pressed="expandedStream?.message.id === item.message.id"
        @click="selectStream(item.message.id)"
      >
        <span class="speaking-dot" :style="{ backgroundColor: identityColor(item.message.senderName) }" />
        <span class="max-w-32 truncate">{{ item.message.senderName }}</span>
        <span class="text-muted-foreground">{{ stripStatus(item) }}</span>
        <LoadingDots v-if="item.pending && !item.message.text" />
      </button>
    </div>
    <div
      v-if="expandedStream"
      :key="expandedStream.message.id"
      class="chat-message"
      :data-message-id="expandedStream.message.id"
      aria-live="polite"
    >
      <ReasoningBlock
        :reasoning="expandedStream.reasoning"
        :running="expandedStream.pending && !expandedStream.message.text"
        :sender="expandedStream.message.senderName"
        class="mb-2"
      />
      <AgentMessage :message="expandedStream.message" :pending="expandedStream.pending" :markdown="markdown">
        <template v-if="$slots.footer" #footer="{ message: footerMessage }">
          <slot name="footer" :message="footerMessage" />
        </template>
      </AgentMessage>
    </div>
    <PanelState v-if="loading" loading title="正在读取群消息" description="正在同步这个团队的共享记录。" />
    <slot v-else-if="!filtered.length && !streamingMessages.length" name="empty">
      <PanelState :icon="MessagesSquare" title="暂无消息" :description="selectedPair ? '这个双人会话还没有消息。' : '成员开始交流后，消息会显示在这里。'" />
    </slot>

  </ConversationPanel>
</template>
