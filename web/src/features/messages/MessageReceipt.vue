<script setup lang="ts">
import { computed } from 'vue';
import { Check, Circle, CircleHelp, TriangleAlert } from '@lucide/vue';
import { directiveStatus } from './directive-status';
import type { TeamDirectiveReceipt } from '@/shared/api/raw-types';

const props = defineProps<{
  receipt: TeamDirectiveReceipt;
  /** 气泡靠哪一侧：贴右时回执也跟着靠右。 */
  align?: 'start' | 'end';
}>();

const emit = defineEmits<{ open: [receipt: TeamDirectiveReceipt] }>();

const state = computed(() => directiveStatus(props.receipt));

// 图标承担"一眼分辨"：勾=正常、三角=异常、问号=不知道、空心圆=在路上。
const icon = computed(() => {
  switch (state.value.tone) {
    case 'success':
      return Check;
    case 'warning':
    case 'danger':
      return TriangleAlert;
    case 'info':
      return CircleHelp;
    default:
      return Circle;
  }
});

function onClick() {
  if (state.value.interactive) emit('open', props.receipt);
}
</script>

<template>
  <!-- 回执只说明"这条消息走没走到",不承载报错正文:完整原因在弹窗里。
       五种状态长得一样——平时一颗图标圆,hover 展开文字;
       "能不能点"只落在光标和点击行为上,不影响外观与动效。 -->
  <p
    class="message-receipt"
    :class="align === 'end' && 'message-receipt--end'"
    aria-live="polite"
  >
    <component
      :is="state.interactive ? 'button' : 'span'"
      class="message-receipt-tag"
      :type="state.interactive ? 'button' : undefined"
      :data-interactive="state.interactive || undefined"
      :data-static="state.interactive ? undefined : ''"
      :data-tone="state.tone"
      :aria-label="state.interactive ? `${state.label}，查看详情` : undefined"
      @click="onClick"
    >
      <component :is="icon" />
      <span class="receipt-extra">
        <span class="receipt-extra-inner">
          <span class="receipt-label">{{ state.label }}</span>
        </span>
      </span>
    </component>
  </p>
</template>
