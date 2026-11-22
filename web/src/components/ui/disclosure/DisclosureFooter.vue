<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { Button } from '@/components/ui/button';
import { CollapseReveal } from '@/components/ui/collapse-reveal';
import DisclosureChevron from './DisclosureChevron.vue';

/**
 * 内容在上、展开/收起按钮在右下角的折叠区：
 * 内部托管 CollapseReveal、pb-2 内留白（收起终点严格 0px）、aria-controls 与箭头动效，
 * 避免调用方手写 CollapseReveal + v-if 或漏接动效契约。
 */
const props = withDefaults(
  defineProps<{
    open?: boolean;
    defaultOpen?: boolean;
    disabled?: boolean;
    collapsedLabel?: string;
    expandedLabel?: string;
    revealTestId?: string;
    toggleTestId?: string;
  }>(),
  {
    open: undefined,
    defaultOpen: false,
    disabled: false,
    collapsedLabel: '展开',
    expandedLabel: '收起',
  },
);

const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const localOpen = ref(props.defaultOpen);
const expanded = computed(() => props.open ?? localOpen.value);
const contentId = `disclosure-footer-${useId()}`;

function toggle() {
  if (props.disabled) return;
  const next = !expanded.value;
  if (props.open === undefined) localOpen.value = next;
  emit('update:open', next);
}
</script>

<template>
  <div class="flex flex-col" data-slot="disclosure-footer">
    <CollapseReveal
      :id="contentId"
      :show="expanded"
      :data-testid="revealTestId"
    >
      <div class="pb-2">
        <slot :open="expanded" />
      </div>
    </CollapseReveal>
    <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
      <slot name="footer-start" :open="expanded" />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        class="ms-auto text-xs text-muted-foreground hover:text-foreground"
        :disabled="disabled"
        :aria-expanded="expanded"
        :aria-controls="contentId"
        :data-testid="toggleTestId"
        @click="toggle"
      >
        {{ expanded ? expandedLabel : collapsedLabel }}
        <DisclosureChevron :open="expanded" />
      </Button>
    </div>
  </div>
</template>
