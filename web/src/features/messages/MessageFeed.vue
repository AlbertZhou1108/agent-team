<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { ArrowDown, LoaderCircle, MessagesSquare } from '@lucide/vue';
import type { MessageView } from '@/shared/models/view-types';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import MessageTrace from '@/components/ai-elements/MessageTrace.vue';
import { Button } from '@/components/ui/button';

const props = defineProps<{
  messages: MessageView[];
  title?: string;
  selectedPair: string;
  hosts?: Record<string, string>;
  loading?: boolean;
  hasNextPage?: boolean;
  fetchingNextPage?: boolean;
}>();

const emit = defineEmits<{
  loadMore: [];
}>();

const filtered = computed(() => (
  props.selectedPair
    ? props.messages.filter(message => message.pairKey === props.selectedPair)
    : props.messages
));

const messageGroups = computed(() => {
  const groups: { id: string; notifications: boolean; messages: MessageView[] }[] = [];
  for (const message of filtered.value) {
    const previous = groups.at(-1);
    if (message.kind === 'system' && previous?.notifications) previous.messages.push(message);
    else groups.push({ id: message.id, notifications: message.kind === 'system', messages: [message] });
  }
  return groups;
});

const stream = ref<HTMLElement>();
const content = ref<HTMLElement>();
const atBottom = ref(true);
let observer: ResizeObserver | undefined;

function updatePosition() {
  const element = stream.value;
  if (element) atBottom.value = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
}

function scrollToBottom() {
  const element = stream.value;
  if (!element) return;
  element.scrollTop = element.scrollHeight;
  updatePosition();
}

// Capture follow intent before Vue appends messages and changes the scroll geometry.
watch(() => filtered.value.map(message => message.id), async () => {
  const follow = atBottom.value;
  await nextTick();
  if (follow) scrollToBottom();
  else updatePosition();
}, { flush: 'pre' });

watch(() => props.selectedPair, async () => {
  atBottom.value = true;
  await nextTick();
  scrollToBottom();
});

onMounted(() => {
  scrollToBottom();
  observer = new ResizeObserver(() => {
    // Trace details and viewport resizing may change height after message rendering.
    if (atBottom.value) scrollToBottom();
    else updatePosition();
  });
  if (content.value) observer.observe(content.value);
  if (stream.value) observer.observe(stream.value);
});
onBeforeUnmount(() => observer?.disconnect());

</script>

<template>
  <section class="message-feed min-w-0">
    <div class="message-toolbar">
      <h3 class="truncate text-sm font-medium">{{ title ?? '全部群消息' }}</h3>
    </div>

    <div class="message-viewport">
      <div ref="stream" class="message-stream" @scroll="updatePosition">
        <div ref="content" class="message-content">
          <div v-for="group in messageGroups" :key="group.id" class="chat-message">
            <details v-if="group.notifications && group.messages.length > 1" class="notification-stack">
              <summary>
                <span class="font-medium">系统通知 <span class="text-xs text-muted-foreground">{{ group.messages.length }} 条</span></span>
                <span class="notification-expand text-xs text-muted-foreground">展开</span>
                <span class="notification-collapse text-xs text-muted-foreground">收起</span>
              </summary>
              <div class="flex flex-col gap-2 p-3">
                <AgentMessage v-for="message in group.messages" :key="message.id" :message="message" />
              </div>
            </details>
            <template v-else>
            <MessageTrace
              :message-id="group.messages[0]!.id"
              :hosts="hosts ?? {}"
            />
            <AgentMessage :message="group.messages[0]!" />
            </template>
          </div>
          <div v-if="!filtered.length && !loading" class="empty-state">
            <MessagesSquare :size="22" />
            <p>{{ selectedPair ? '这个双人会话还没有消息。' : '还没有群消息。成员会通过群工具在这里出现。' }}</p>
          </div>
          <div v-if="loading" class="empty-state">
            <LoaderCircle :size="20" class="animate-spin" />
            <p>正在读取群消息…</p>
          </div>
        </div>
      </div>
      <Button
        v-if="!atBottom"
        class="jump-to-bottom rounded-full"
        variant="secondary"
        size="icon"
        aria-label="回到底部"
        title="回到底部"
        @click="scrollToBottom"
      >
        <ArrowDown :size="18" aria-hidden="true" />
      </Button>
    </div>

    <Button
      v-if="hasNextPage"
      variant="outline"
      size="sm"
      class="mb-2 mt-2 w-full"
      :disabled="fetchingNextPage"
      @click="emit('loadMore')"
    >
      <LoaderCircle v-if="fetchingNextPage" :size="13" class="animate-spin" />
      {{ fetchingNextPage ? '正在加载' : '加载更多消息' }}
    </Button>
  </section>
</template>
