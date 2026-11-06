<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { ChevronRight } from '@lucide/vue';
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CollapseReveal } from '@/components/ui/collapse-reveal';

const props = withDefaults(defineProps<{ open?: boolean; defaultOpen?: boolean; disabled?: boolean; headingLevel?: 2 | 3 | 4; variant?: 'plain' | 'card'; persistActions?: boolean }>(), { open: undefined, defaultOpen: false, variant: 'plain', persistActions: false });
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
    <!-- 头部动作默认只作用于子内容,收起时随内容一起不渲染(不可聚焦、不进
         可访问树);persistActions 用于动作作用于"这一节本身"(置顶、关闭),
         与展开状态无关。不另设动画,转移终点直接落在目标状态。 -->
    <div v-if="$slots.actions && (expanded || persistActions)" data-slot="disclosure-actions"><slot name="actions" /></div>
    </div>
    <CollapseReveal :id="contentId" :show="expanded">
      <div data-slot="disclosure-content">
        <div v-if="$slots.description" data-slot="disclosure-description"><slot name="description" /></div>
        <slot :open="expanded" />
      </div>
    </CollapseReveal>
  </Collapsible>
</template>
