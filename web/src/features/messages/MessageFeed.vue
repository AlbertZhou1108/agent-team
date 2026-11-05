<script setup lang="ts">
import FeedPanel from '@/components/ai-elements/FeedPanel.vue';
import { computed, ref, watch } from 'vue';
import type { MessageFeedProps } from './message-feed-types';
import PanelState from '@/components/panel/PanelState.vue';
import { LoaderCircle, MessagesSquare, Clock3 } from '@lucide/vue';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import ConversationPanel from '@/components/ai-elements/ConversationPanel.vue';
import ConversationOutline from './ConversationOutline.vue';
import MessageTrace from '@/components/ai-elements/MessageTrace.vue';
import RunStatusCard from '@/components/ai-elements/RunStatusCard.vue';
import { Badge } from '@/components/ui/badge';
import type { Interaction } from '@/shared/api/raw-types';
import { directiveStatus } from './directive-status';
import type { StreamView } from './adapters';
import { buildMessageGroups, isSystemStack } from './message-groups';
import { Button } from '@/components/ui/button';
import InteractionCard from './InteractionCard.vue';
import StreamingMessages from './StreamingMessages.vue';

const props = withDefaults(
  defineProps<MessageFeedProps>(),
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
    traceable: true,
    markdown: true,
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
// 执行轨迹的开关收进消息头:收起时零占位(药丸形态曾占会话两成高度),
// 展开状态在这里统一持有 —— 普通消息按消息 id,群发组只有一颗开关、
// 展开堆叠组内全部轨迹,键取组首消息 id。
const expandedTraces = ref(new Set<string>());
watch(
  () => props.resetKey ?? props.selectedPair,
  () => {
    selectedRunKey.value = null;
    expandedTraces.value = new Set();
  },
);
const traceExpanded = (id: string) => expandedTraces.value.has(id);
function toggleTrace(id: string) {
  const next = new Set(expandedTraces.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedTraces.value = next;
}

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
// 哪些消息可以展开执行轨迹:轨迹的单位是消息,每条消息对应它自己那次发送的
// 事件段。系统通知、用户发言、以及后端查不到回合来源的消息都不提供入口——
// 展开只会是「没有可用的执行轨迹」。
const traceCandidates = computed(() => {
  const ids = new Set<string>();
  for (const message of filtered.value) {
    if (message.kind === 'system' || message.senderIsUser) continue;
    if (!message.turnId) continue;
    ids.add(message.id);
  }
  return ids;
});
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
    <template #bar-top><slot name="bar-top" /></template>
    <!-- 运行状态与输入区共用底栏，始终位于输入框上方。 -->
    <template #bar-bottom>
      <RunStatusCard
        :source="readStreamViews"
        :selected-key="selectedRunKey"
        :group-names="groupNames"
        @select="selectedRunKey = $event"
      />
      <slot name="bar-bottom" />
    </template>
    <!-- 会话大纲挂在滚动区之上的浮层里:只跟视口位置走,不随内容滚走。 -->
    <template #overlay="{ viewport }">
      <ConversationOutline :messages="messages" :viewport="viewport" />
    </template>
    <div v-if="hasNextPage" class="flex justify-center py-2">
      <Button variant="outline" size="sm" :disabled="fetchingNextPage" @click="emit('loadMore')">
        <LoaderCircle v-if="fetchingNextPage" class="animate-spin" />
        {{ fetchingNextPage ? '正在加载' : '加载更早消息' }}
      </Button>
    </div>
    <div v-for="group in renderGroups" :key="group.id" class="chat-message">
      <FeedPanel
        v-if="group.stack"
        class="notification-stack"
        label="系统通知"
        :count="group.messages.length"
      >
        <div class="flex flex-col gap-2 p-3">
          <AgentMessage
            v-for="message in group.messages"
            :key="message.id"
            :message="message"
          />
        </div>
      </FeedPanel>
      <template v-else-if="group.fanout">
        <!-- 轨迹以消息为单位:同一指令发往多个成员是多次独立的发送,各自一段轨迹。
             正文只展示一次,但每条消息保留自己的锚点、轨迹与回执。
             开关只有消息头上一颗,展开后组内全部轨迹按接收者标注堆叠。 -->
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
            <template #header-actions>
              <Button
                v-if="traceable && traceCandidates.has(message.id)"
                variant="ghost"
                size="icon-xs"
                class="message-actions message-trace-toggle"
                :data-active="traceExpanded(message.id)"
                :aria-expanded="traceExpanded(message.id)"
                :aria-label="`本次群发的执行轨迹`"
                title="执行轨迹"
                @click="toggleTrace(message.id)"
              >
                <Clock3 />
              </Button>
            </template>
            <template v-if="$slots.footer" #footer="{ message }">
              <slot name="footer" :message="message" />
            </template>
          </AgentMessage>
          <template v-if="index === 0 && traceExpanded(message.id)">
            <template v-for="traceMessage in group.messages" :key="traceMessage.id">
              <MessageTrace
                v-if="traceCandidates.has(traceMessage.id)"
                :message-id="traceMessage.id"
                :hosts="hosts ?? {}"
                expanded
                :align="traceMessage.senderIsUser ? 'end' : 'start'"
                :label="traceMessage.recipientName"
              />
            </template>
          </template>
          <p
            v-if="index > 0"
            class="sr-only"
            aria-hidden="true"
          >{{ message.senderName }} → {{ message.recipientName }}：{{ message.text }}</p>
          <InteractionCard
            v-for="interaction in messageInteractions[message.id] ?? []"
            :key="interaction.id"
            :interaction="interaction"
            class="mt-2"
          />
          <p
            v-if="receipts[message.id]"
            class="message-receipt"
            :class="message.senderIsUser && 'message-receipt--end'"
            aria-live="polite"
          >
            <Badge variant="outline">{{ directiveStatus(receipts[message.id]!) }}</Badge>
            <span v-if="receipts[message.id]!.error">{{ receipts[message.id]!.error }}</span>
          </p>
        </div>
      </template>
      <template v-else>
        <!-- 每条消息保留独立锚点;同发送者连续消息仅首条显示身份。
             轨迹跟随各自的消息,不同消息对应不同的产出事件段。 -->
        <div
          v-for="(message, index) in group.messages"
          :key="message.id"
          :data-message-id="message.id"
        >
          <AgentMessage :message="message" :compact="index > 0" :markdown="markdown">
            <template #header-actions>
              <Button
                v-if="traceable && traceCandidates.has(message.id)"
                variant="ghost"
                size="icon-xs"
                class="message-actions message-trace-toggle"
                :data-active="traceExpanded(message.id)"
                :aria-expanded="traceExpanded(message.id)"
                :aria-label="`消息 #${message.seq} 的执行轨迹`"
                title="执行轨迹"
                @click="toggleTrace(message.id)"
              >
                <Clock3 />
              </Button>
            </template>
            <template v-if="$slots.footer" #footer="{ message }">
              <slot name="footer" :message="message" />
            </template>
          </AgentMessage>
          <MessageTrace
            v-if="traceable && traceCandidates.has(message.id)"
            :message-id="message.id"
            :hosts="hosts ?? {}"
            :expanded="traceExpanded(message.id)"
            :align="message.senderIsUser ? 'end' : 'start'"
          />
          <InteractionCard
            v-for="interaction in messageInteractions[message.id] ?? []"
            :key="interaction.id"
            :interaction="interaction"
            class="mt-2"
          />
          <p
            v-if="receipts[message.id]"
            class="message-receipt"
            :class="message.senderIsUser && 'message-receipt--end'"
            aria-live="polite"
          >
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
    <PanelState v-if="loading" loading title="正在读取消息" />
    <slot v-else-if="!filtered.length && !streamingCount" name="empty">
      <PanelState :icon="MessagesSquare" title="暂无消息" />
    </slot>


  </ConversationPanel>
</template>
