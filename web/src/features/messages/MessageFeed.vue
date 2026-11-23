<script setup lang="ts">
import FeedPanel from '@/components/ai-elements/FeedPanel.vue';
import { computed, provide, ref, watch } from 'vue';
import type { MessageFeedProps } from './message-feed-types';
import { filePreviewContext } from './file-refs';
import FilePreviewDialog from './FilePreviewDialog.vue';
import PanelState from '@/components/panel/PanelState.vue';
import { ChevronRight, LoaderCircle, MessagesSquare } from '@lucide/vue';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import ConversationPanel from '@/components/ai-elements/ConversationPanel.vue';
import ConversationOutline from './ConversationOutline.vue';
import MessageTrace from '@/components/ai-elements/MessageTrace.vue';
import RunStatusCard from '@/components/ai-elements/RunStatusCard.vue';
import type { Interaction, TeamDirectiveReceipt } from '@/shared/api/raw-types';
import MessageReceipt from './MessageReceipt.vue';
import DeliveryFailureDialog from './DeliveryFailureDialog.vue';
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

const previewPath = ref('');
const previewOpen = ref(false);
provide(filePreviewContext, {
  open(path: string) {
    if (!props.groupId || !path) return;
    previewPath.value = path;
    previewOpen.value = true;
  },
});

// 多路并发时由运行卡决定展示哪一路正文;切换会话时清空选择。
const selectedRunKey = ref<string | null>(null);
// 执行轨迹以轻量折叠条挂在消息气泡上方:收起时只占一行文字,
// 展开状态与摘要文案在这里统一持有 —— 普通消息按消息 id,群发组取组首消息 id。
const expandedTraces = ref(new Set<string>());
const traceSummaries = ref<Record<string, string>>({});
// 已加载消息超过上限时只渲染最近一段,避免超长会话累积数千 DOM 节点;
// 更早的消息已在内存里,点按钮即时展开,不需要重新请求。
const RENDER_STEP = 600;
const renderedLimit = ref(RENDER_STEP);
watch(
  () => props.resetKey ?? props.selectedPair,
  () => {
    selectedRunKey.value = null;
    expandedTraces.value = new Set();
    traceSummaries.value = {};
    renderedLimit.value = RENDER_STEP;
  },
);
const traceExpanded = (id: string) => expandedTraces.value.has(id);
function toggleTrace(id: string) {
  const next = new Set(expandedTraces.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedTraces.value = next;
}
function setTraceSummary(id: string, summary: string) {
  if (!summary || traceSummaries.value[id] === summary) return;
  traceSummaries.value = { ...traceSummaries.value, [id]: summary };
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

// 互动卡是唯一展示面:锚点消息只为答复线程与群记录存在,不再渲染正文。
// 由卡片自身的 payload.cardOnly 声明;老数据没声明,仍按普通消息渲染,行为不变。
const cardAnchorIds = computed(() => {
  const ids = new Set<string>();
  for (const item of props.interactions ?? []) {
    if (item.message_id && item.payload?.cardOnly) ids.add(item.message_id);
  }
  return ids;
});
const isCardAnchor = (message: { id: string }) => cardAnchorIds.value.has(message.id);
/** 卡片本体上位时用消息补回「谁 · 什么时候」;有气泡时由气泡承担。 */
const anchorOf = (message: { id: string; senderName: string; createdAt: string }) =>
  isCardAnchor(message) ? { senderName: message.senderName, createdAt: message.createdAt } : undefined;

const renderedMessages = computed(() =>
  filtered.value.length > renderedLimit.value
    ? filtered.value.slice(filtered.value.length - renderedLimit.value)
    : filtered.value,
);
const hiddenMessageCount = computed(() => filtered.value.length - renderedMessages.value.length);
const messageGroups = computed(() =>
  buildMessageGroups(renderedMessages.value, {
    groupSystemMessages: props.groupSystemMessages,
    isBlocked: isCardAnchor,
  }),
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
// 投递详情只留一个弹窗实例：回执标签散落在消息流里，各自挂一个 Dialog 太重。
const activeReceipt = ref<TeamDirectiveReceipt | null>(null);
const receiptOpen = ref(false);
function openReceipt(receipt: TeamDirectiveReceipt) {
  // 回执里只有接收者 id。名字属于展示层：同一 id 的接收者名消息流里已经有了，
  // 打开时补一次，弹窗才不会把 UUID 当人名显示。
  const recipientName = props.messages.find(message => message.id === receipt.messageId)?.recipientName;
  activeReceipt.value = { ...receipt, recipientName };
  receiptOpen.value = true;
}
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
        :on-stop="onStopRun"
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
    <div v-if="hiddenMessageCount > 0" class="flex justify-center py-2">
      <Button variant="outline" size="sm" @click="renderedLimit += RENDER_STEP">
        显示更早的 {{ hiddenMessageCount }} 条（已加载）
      </Button>
    </div>
    <div v-for="group in renderGroups" :key="group.id" class="chat-message">
      <FeedPanel
        v-if="group.stack"
        class="notification-stack"
        label="系统通知"
        :count="group.messages.length"
      >
        <div class="flex flex-col gap-1 px-2 py-1.5">
          <AgentMessage
            v-for="message in group.messages"
            :key="message.id"
            :message="message"
            stacked
          />
        </div>
      </FeedPanel>
      <template v-else-if="group.fanout">
        <!-- 轨迹以消息为单位:同一指令发往多个成员是多次独立的发送,各自一段轨迹。
             正文只展示一次,折叠开关挂在气泡上方,展开后组内全部轨迹按接收者标注堆叠。 -->
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
            <template
              v-if="traceable && group.messages.some(item => traceCandidates.has(item.id))"
              #above
            >
              <div class="inline-trace-wrap" :class="message.senderIsUser && 'inline-trace-wrap--end'">
                <button
                  type="button"
                  class="inline-trace-toggle"
                  :data-active="traceExpanded(message.id)"
                  :aria-expanded="traceExpanded(message.id)"
                  aria-label="本次群发的执行轨迹"
                  @click="toggleTrace(message.id)"
                >
                  <span>{{ traceSummaries[message.id] ?? '执行轨迹' }}</span>
                  <ChevronRight
                    class="size-3.5 shrink-0 transition-transform duration-(--component-feedback-duration)"
                    :class="traceExpanded(message.id) && 'rotate-90'"
                    aria-hidden="true"
                  />
                </button>
                <template v-if="traceExpanded(message.id)">
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
              </div>
            </template>
            <template v-if="receipts[message.id]" #below>
              <MessageReceipt
                :receipt="receipts[message.id]!"
                :align="message.senderIsUser ? 'end' : 'start'"
                @open="openReceipt"
              />
            </template>
            <template v-if="$slots.footer" #footer="{ message: footerMessage }">
              <slot name="footer" :message="footerMessage" />
            </template>
          </AgentMessage>
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
          <MessageReceipt
            v-if="index > 0 && receipts[message.id]"
            :receipt="receipts[message.id]!"
            :align="message.senderIsUser ? 'end' : 'start'"
            @open="openReceipt"
          />
        </div>
      </template>
      <template v-else>
        <!-- 每条消息保留独立锚点;同发送者连续消息仅首条显示身份。
             轨迹折叠挂在气泡上方,先轨迹后正文。 -->
        <div
          v-for="(message, index) in group.messages"
          :key="message.id"
          :data-message-id="message.id"
        >
          <!-- 卡片锚点:正文与卡片重复,只保留卡片本体。 -->
          <AgentMessage v-if="!isCardAnchor(message)" :message="message" :compact="index > 0" :markdown="markdown">
            <template v-if="traceable && traceCandidates.has(message.id)" #above>
              <div class="inline-trace-wrap" :class="message.senderIsUser && 'inline-trace-wrap--end'">
                <button
                  type="button"
                  class="inline-trace-toggle"
                  :data-active="traceExpanded(message.id)"
                  :aria-expanded="traceExpanded(message.id)"
                  :aria-label="`消息 #${message.seq} 的执行轨迹`"
                  @click="toggleTrace(message.id)"
                >
                  <span>{{ traceSummaries[message.id] ?? '执行轨迹' }}</span>
                  <ChevronRight
                    class="size-3.5 shrink-0 transition-transform duration-(--component-feedback-duration)"
                    :class="traceExpanded(message.id) && 'rotate-90'"
                    aria-hidden="true"
                  />
                </button>
                <MessageTrace
                  :message-id="message.id"
                  :hosts="hosts ?? {}"
                  :expanded="traceExpanded(message.id)"
                  :align="message.senderIsUser ? 'end' : 'start'"
                  @summary="setTraceSummary(message.id, $event)"
                />
              </div>
            </template>
            <template v-if="receipts[message.id]" #below>
              <MessageReceipt
                :receipt="receipts[message.id]!"
                :align="message.senderIsUser ? 'end' : 'start'"
                @open="openReceipt"
              />
            </template>
            <template v-if="$slots.footer" #footer="{ message: footerMessage }">
              <slot name="footer" :message="footerMessage" />
            </template>
          </AgentMessage>
          <InteractionCard
            v-for="interaction in messageInteractions[message.id] ?? []"
            :key="interaction.id"
            :interaction="interaction"
            :anchor="anchorOf(message)"
            class="mt-2"
          />
          <MessageReceipt
            v-if="isCardAnchor(message) && receipts[message.id]"
            :receipt="receipts[message.id]!"
            :align="message.senderIsUser ? 'end' : 'start'"
            @open="openReceipt"
          />
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

    <DeliveryFailureDialog v-model:open="receiptOpen" :receipt="activeReceipt" />
    <FilePreviewDialog v-if="groupId" v-model:open="previewOpen" :group-id="groupId" :file-path="previewPath" />
  </ConversationPanel>
</template>
