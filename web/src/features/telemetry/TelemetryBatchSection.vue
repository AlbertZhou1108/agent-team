<script setup lang="ts">
import type { Component } from 'vue';
import { LoaderCircle } from '@lucide/vue';
import { Disclosure } from '@/components/ui/disclosure';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollRegion } from '@/components/ui/scroll-region';
import PanelState from '@/components/panel/PanelState.vue';

/**
 * 批次区的统一外壳:卡片即折叠区,展开后是自带滚动的列表 —— 默认收起,
 * 批次列表不撑长整块面板。批次的每一行由使用方放进默认插槽,行间分割线
 * 由这里提供,行本身不再带卡片边框。
 */
withDefaults(
  defineProps<{
    /** 当前已载入的批次数。 */
    count: number;
    emptyTitle: string;
    emptyDescription: string;
    emptyIcon?: Component;
    /** 是否还有下一页。 */
    hasMore?: boolean;
    fetching?: boolean;
  }>(),
  { hasMore: false, fetching: false },
);

const emit = defineEmits<{ loadMore: [] }>();
</script>

<template>
  <Disclosure variant="card" class="min-w-0" :heading-level="4">
    <template #summary>
      <span class="text-sm font-semibold">批次</span>
      <Badge variant="outline">{{ count }} 个</Badge>
      <slot name="badges" />
    </template>
    <div class="flex min-w-0 flex-col gap-2">
      <slot name="notice" />
      <PanelState
        v-if="!count"
        :icon="emptyIcon"
        :title="emptyTitle"
        :description="emptyDescription"
      />
      <template v-else>
        <ScrollRegion label="批次列表" max-height="min(28rem,60vh)" gap="0.5rem">
          <div class="divide-y divide-border">
            <slot />
          </div>
          <Button
            v-if="hasMore"
            variant="outline"
            size="sm"
            class="w-full"
            :disabled="fetching"
            @click="emit('loadMore')"
          >
            <LoaderCircle v-if="fetching" class="animate-spin" />
            {{ fetching ? '正在加载' : '加载更多批次' }}
          </Button>
        </ScrollRegion>
      </template>
    </div>
  </Disclosure>
</template>
