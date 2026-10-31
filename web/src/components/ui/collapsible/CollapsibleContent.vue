<script setup lang="ts">
import type { CollapsibleContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { computed } from "vue"
import { CollapsibleContent } from "reka-ui"

const props = defineProps<CollapsibleContentProps & { class?: HTMLAttributes["class"] }>()

// forceMount + 自管可见性:展开/收起由根节点 data-state 经 CSS
// (grid-template-rows 0fr→1fr,祖先选择器)驱动,每帧按真实布局解析行高,
// 不存在"开启瞬间测量"导致的过冲,也不受 reka 内容元素内联样式影响。
// 注意:当前应用无嵌套折叠;若未来出现,祖先选择器需改为就近匹配方案。
const delegatedProps = computed(() => {
  const { class: _, ...rest } = props
  return { ...rest, forceMount: true }
})
</script>

<template>
  <CollapsibleContent
    data-slot="collapsible-content"
    class="collapsible-clip-host"
    v-bind="delegatedProps"
  >
    <div class="collapsible-clip">
      <div class="collapsible-clip-clip" :class="props.class">
        <slot />
      </div>
    </div>
  </CollapsibleContent>
</template>
