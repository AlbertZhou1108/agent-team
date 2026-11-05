<script setup lang="ts">
/**
 * 会话流里的顶层折叠面板:标题 + 计数 + 展开后的内容插槽。
 *
 * 只管三件事:标题行的排版、药丸外形(收起的可点区域不横贯整栏)、开合状态。
 * 数据与内容全部归调用方 —— 系统通知塞消息列表、执行轨迹塞异步读取的卡片。
 *
 * 开合走非受控:本组件持有状态,外部通过 update:open 得知变化。
 * 需要外部控制时再加一个可选 open prop 覆盖即可,不必现在承担这层判断。
 */
import { ref, type Component } from 'vue';
import { Disclosure } from '@/components/ui/disclosure';

const props = withDefaults(
  defineProps<{
    /** 标题 */
    label: string;
    /** 计数,渲染成小号的「N 条」;不传则不显示 */
    count?: number;
    countUnit?: string;
    /** 标题前的图标 */
    icon?: Component;
    /** 内容靠右(用户发言那一侧) */
    align?: 'start' | 'end';
    defaultOpen?: boolean;
  }>(),
  { countUnit: '条', align: 'start', defaultOpen: false },
);

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

// 内容常驻 DOM(CollapseReveal 只做收拢 + inert),所以「展开才请求」必须靠
// 插槽拿到的 open 驱动,不能指望 v-if 挂载。
const open = ref(props.defaultOpen);

function update(value: boolean) {
  open.value = value;
  emit('update:open', value);
}
</script>

<template>
  <Disclosure
    class="feed-panel"
    :class="align === 'end' && 'feed-panel--end'"
    :open="open"
    @update:open="update"
  >
    <template #summary>
      <component :is="icon" v-if="icon" class="size-3.5 shrink-0" />
      <span class="font-medium">
        {{ label }}<span
          v-if="count !== undefined"
          class="ms-1 text-xs tabular-nums text-muted-foreground"
        >{{ count }} {{ countUnit }}</span>
      </span>
    </template>
    <slot :open="open" />
  </Disclosure>
</template>
