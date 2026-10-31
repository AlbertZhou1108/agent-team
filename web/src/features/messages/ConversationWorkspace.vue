<script setup lang="ts">
import { computed } from 'vue';
import ConversationFrame from '@/components/ai-elements/ConversationFrame.vue';
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
const emit = defineEmits<{ loadMore: []; retry: [] }>();
const feedProps = computed(() => {
  const { heading, description, error, retryable, readonly, ...feed } = props;
  return feed;
});
</script>

<template>
  <ConversationFrame class="conversation-workspace" :readonly="readonly ?? false">
    <header class="conversation-header" data-surface="action">
      <slot name="leading" />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <h1 class="min-w-0 truncate text-base font-semibold" :title="heading">{{ heading }}</h1>
          <slot name="heading-meta" />
        </div>
        <p v-if="description" class="mt-1 truncate text-xs text-muted-foreground" :title="description">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2"><slot name="actions" /></div>
    </header>
    <Alert v-if="error" variant="destructive" class="mx-4 mb-2 w-auto" role="alert">
      <AlertDescription class="flex items-center gap-2">
        <span class="min-w-0 flex-1">{{ error }}</span>
        <Button v-if="retryable" variant="outline" size="sm" @click="emit('retry')">重试</Button>
      </AlertDescription>
    </Alert>
    <slot name="status" />
    <slot name="context" />
    <MessageFeed v-bind="feedProps" @load-more="emit('loadMore')">
      <template v-if="$slots.empty" #empty><slot name="empty" /></template>
      <template v-if="$slots.footer" #footer="scope"><slot name="footer" v-bind="scope" /></template>
    </MessageFeed>
    <template v-if="!readonly && $slots.composer" #composer><slot name="composer" /></template>
  </ConversationFrame>
</template>
