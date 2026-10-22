<script setup lang="ts">
import ConversationScroller from './ConversationScroller.vue';

withDefaults(defineProps<{
  ids: Array<string | number>;
  resetKey?: string | number;
  readonly?: boolean;
  ariaLabel?: string;
  viewportClass?: string;
  streamClass?: string;
  contentClass?: string;
}>(), {
  resetKey: undefined,
  readonly: true,
  ariaLabel: '会话消息',
  viewportClass: '',
  streamClass: '',
  contentClass: '',
});

defineSlots<{
  header?: () => unknown;
  context?: () => unknown;
  default?: () => unknown;
  footer?: () => unknown;
  composer?: () => unknown;
}>();
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col">
    <slot name="header" />
    <slot name="context" />
    <div class="flex min-h-0 flex-1">
      <ConversationScroller
        :ids="ids"
        :reset-key="resetKey"
        :aria-label="ariaLabel"
        :viewport-class="viewportClass"
        :stream-class="streamClass"
        :content-class="contentClass"
      >
        <slot />
      </ConversationScroller>
    </div>
    <slot name="footer" />
    <template v-if="!readonly && $slots.composer">
      <slot name="composer" />
    </template>
  </section>
</template>
