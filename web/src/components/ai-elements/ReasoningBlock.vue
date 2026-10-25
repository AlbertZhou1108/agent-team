<script setup lang="ts">
import { computed } from 'vue';
import { Brain, ChevronRight } from '@lucide/vue';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { usePreferencesStore } from '@/stores/preferences';
import { identityColor } from '@/features/messages/identity';
import LoadingDots from './LoadingDots.vue';

const props = withDefaults(
  defineProps<{
    reasoning?: string | null;
    running?: boolean;
    /** 归属成员名;并发思考时区分谁在思考。 */
    sender?: string | null;
  }>(),
  { sender: null },
);
const preferences = usePreferencesStore();
const senderColor = computed(() => (props.sender ? identityColor(props.sender) : undefined));
</script>

<template>
  <Collapsible
    v-if="preferences.showReasoning"
    class="reasoning-block group"
  >
    <CollapsibleTrigger
      class="flex w-full items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <Brain class="size-3.5 shrink-0" />
      <span class="min-w-0 flex-1 truncate text-left">
        <template v-if="sender"
          ><span
            class="font-medium"
            :style="{ color: senderColor }"
            >{{ sender }}</span
          >
          ·
        </template>
        {{ running ? '思考中' : '思考过程' }}
      </span>
      <LoadingDots v-if="running" />
      <ChevronRight
        class="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
      />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <p
        v-if="reasoning"
        class="scrollbar-thin mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-l-2 pl-2.5 text-xs text-muted-foreground"
      >
        {{ reasoning }}
      </p>
    </CollapsibleContent>
  </Collapsible>
</template>
