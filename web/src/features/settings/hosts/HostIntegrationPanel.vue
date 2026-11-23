<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { RefreshCw } from '@lucide/vue';
import { api } from '@/shared/api/client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';
import HelpPopover from '@/components/panel/HelpPopover.vue';
import { HOST_KINDS, availabilityVariant, hostCardModel } from './host-view-model';
import type { HostKind } from './host-view-model';

const props = defineProps<{ active: boolean }>();
const emit = defineEmits<{ 'open-detail': [kind: HostKind] }>();

const applications = useQuery({
  queryKey: ['desktop-applications'],
  queryFn: () => api.desktopApplications(),
  enabled: computed(() => props.active),
  retry: false,
  staleTime: 30000,
  gcTime: 30000,
  refetchOnWindowFocus: false,
});

const cards = computed(() => HOST_KINDS.map(kind => hostCardModel(
  kind,
  applications.data.value?.find(item => item.kind === kind),
)));

const refreshing = computed(() => applications.isFetching.value);

async function refresh() {
  await applications.refetch();
}
</script>

<template>
  <section class="flex flex-col gap-3" aria-labelledby="host-integration-title">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-1">
        <h3 id="host-integration-title" class="text-sm font-semibold">宿主集成</h3>
        <HelpPopover title="宿主集成">
          <p>按宿主查看桌面应用与内置执行引擎状态；列表只显示是否可用，差异在详情页展示。</p>
        </HelpPopover>
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        :disabled="refreshing"
        :title="refreshing ? '正在检测' : '重新检测'"
        :aria-label="refreshing ? '正在检测' : '重新检测'"
        @click="refresh"
      >
        <RefreshCw :class="refreshing ? 'animate-spin' : ''" />
      </Button>
    </div>

    <Alert v-if="applications.error.value" variant="destructive">
      <AlertDescription>桌面应用状态读取失败，请检查服务连接。</AlertDescription>
    </Alert>

    <Empty v-if="applications.isSuccess.value && !cards.length">
      <EmptyHeader>
        <EmptyTitle>暂无受支持的桌面应用</EmptyTitle>
        <EmptyDescription>受支持的桌面应用为 Codex、Claude、DeepSeek Harness 与 ZCode。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <ItemGroup class="gap-2">
      <Item
        v-for="card in cards"
        :key="card.kind"
        variant="outline"
        size="sm"
        class="min-h-20"
      >
        <ItemContent class="min-w-0 flex-1">
          <ItemTitle>
            {{ card.title }}
            <Badge :variant="availabilityVariant(card.availability)">{{ card.stateLabel }}</Badge>
          </ItemTitle>
          <p class="text-xs text-muted-foreground">{{ card.summary }}</p>
        </ItemContent>
        <ItemActions class="ml-auto">
          <Button type="button" variant="outline" size="sm" @click="emit('open-detail', card.kind)">
            查看详情
          </Button>
        </ItemActions>
      </Item>
    </ItemGroup>
  </section>
</template>
