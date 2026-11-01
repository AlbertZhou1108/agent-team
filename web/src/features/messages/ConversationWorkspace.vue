<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue';
import { referenceContext, type MessageReference } from './references';
import ConversationFrame from '@/components/ai-elements/ConversationFrame.vue';
import { Surface } from '@/components/surface';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import MessageFeed from './MessageFeed.vue';
import type { MessageFeedProps } from './message-feed-types';

const props = withDefaults(defineProps<MessageFeedProps & {
  heading: string;
  description?: string;
  error?: string;
  retryable?: boolean;
  readonly?: boolean;
}>(), { groupSystemMessages: true, markdown: true, readonly: false });
const references=ref<MessageReference[]>([]);
provide(referenceContext,{items:references,enabled:computed(()=>!props.readonly),add(item){if(!references.value.some(x=>x.id===item.id))references.value.push(item);}});
watch(()=>[props.resetKey,props.selectedPair,props.heading],()=>{references.value=[];});
const emit = defineEmits<{ loadMore: []; retry: [] }>();
const feedProps = computed(() => {
  const { heading, description, error, retryable, readonly, ...feed } = props;
  return feed;
});
</script>

<template>
  <!-- overlay 结构:操作区/横幅进 bar-top、输入区进 bar-bottom,都落在
       MessageFeed 的滚动区内 —— 消息从栏下穿过(所有材质共用此结构,
       玻璃只是让穿越可见)。 -->
  <ConversationFrame class="conversation-workspace">
    <MessageFeed v-bind="feedProps" @load-more="emit('loadMore')">
      <template #bar-top>
        <Surface role="action" as="header" class="conversation-header">
          <slot name="leading" />
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <h1 class="min-w-0 truncate text-base font-semibold" :title="heading">{{ heading }}</h1>
              <slot name="heading-meta" />
            </div>
            <p v-if="description" class="mt-1 truncate text-xs text-muted-foreground" :title="description">{{ description }}</p>
          </div>
          <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2"><slot name="actions" /></div>
        </Surface>
        <Alert v-if="error" variant="destructive" class="mx-4 mb-2 w-auto" role="alert">
          <AlertDescription class="flex items-center gap-2">
            <span class="min-w-0 flex-1">{{ error }}</span>
            <Button v-if="retryable" variant="outline" size="sm" @click="emit('retry')">重试</Button>
          </AlertDescription>
        </Alert>
        <slot name="status" />
        <slot name="context" />
      </template>
      <template v-if="$slots.empty" #empty><slot name="empty" /></template>
      <template v-if="$slots.footer" #footer="scope"><slot name="footer" v-bind="scope" /></template>
      <template #bar-bottom>
        <template v-if="!readonly && $slots.composer"><slot name="composer" /></template>
      </template>
    </MessageFeed>
  </ConversationFrame>
</template>
