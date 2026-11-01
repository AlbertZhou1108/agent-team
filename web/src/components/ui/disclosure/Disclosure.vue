<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { ChevronRight } from '@lucide/vue';
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CollapseReveal } from '@/components/ui/collapse-reveal';

const props = withDefaults(defineProps<{ open?: boolean; defaultOpen?: boolean; disabled?: boolean; headingLevel?: 2 | 3 | 4; variant?: 'plain' | 'card' }>(), { open: undefined, defaultOpen: false, variant: 'plain' });
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const localOpen = ref(props.defaultOpen);
const expanded = computed(() => props.open ?? localOpen.value);
const contentId = `disclosure-${useId()}`;
function update(value: boolean) {
  if (props.disabled) return;
  if (props.open === undefined) localOpen.value = value;
  emit('update:open', value);
}
</script>

<template>
  <Collapsible :open="expanded" :disabled="disabled" @update:open="update" data-slot="disclosure" :data-variant="variant">
    <div data-slot="disclosure-header">
    <component :is="headingLevel ? `h${headingLevel}` : 'div'" data-slot="disclosure-title">
    <CollapsibleTrigger :aria-controls="contentId" data-slot="disclosure-trigger">
      <ChevronRight data-part="disclosure-indicator" aria-hidden="true" />
      <span data-slot="disclosure-heading"><slot name="summary" :open="expanded" /></span>
    </CollapsibleTrigger>
    </component>
    <div v-if="$slots.actions" data-slot="disclosure-actions"><slot name="actions" :open="expanded" /></div>
    </div>
    <CollapseReveal :id="contentId" :show="expanded">
      <div data-slot="disclosure-content">
        <div v-if="$slots.description" data-slot="disclosure-description"><slot name="description" /></div>
        <slot :open="expanded" />
      </div>
    </CollapseReveal>
  </Collapsible>
</template>
