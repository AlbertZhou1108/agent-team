<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { computed, nextTick, ref, watch } from 'vue';
import { ArrowLeft } from '@lucide/vue';
import type { Group, ModelPolicy, ModelPolicyDefaults } from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import AppearanceTab from './tabs/AppearanceTab.vue';
import GeneralTab from './tabs/GeneralTab.vue';
import ToolsTab from './tabs/ToolsTab.vue';
import PolicyTab from './tabs/PolicyTab.vue';
import TeamsTab from './tabs/TeamsTab.vue';
import HostDetailPanel from './hosts/HostDetailPanel.vue';
import { HOST_KINDS } from './hosts/host-view-model';
import type { HostKind } from './hosts/host-view-model';

const props = defineProps<{
  policy?: ModelPolicy;
  defaults?: ModelPolicyDefaults;
  archivedTeams?: Group[];
}>();

const emit = defineEmits<{
  close: [];
  saved: [policy: ModelPolicy];
  restoreTeam: [team: Group];
}>();

// 设置页只负责分区导航与入参转发；各分区的状态和交互留在自己的标签组件里。
const activeTab = ref('appearance');
const route = useRoute();
const router = useRouter();

// 宿主详情是设置页里的独立页面（`?host=`），而不是通用分区里的一块内容：
// 进入后不再渲染标签栏和通用分区其余小节。
const hostKind = computed<HostKind | null>(() => {
  const value = String(route.query.host ?? '');
  return (HOST_KINDS as string[]).includes(value) ? value as HostKind : null;
});

function openHostDetail(kind: HostKind) {
  void router.push({ query: { ...route.query, section: 'general', host: kind } });
}

function closeHostDetail() {
  void router.replace({ query: { ...route.query, section: 'general', host: undefined } });
}

watch(() => [route.query.section, route.query.setting], async () => {
  const section = String(route.query.section ?? 'appearance');
  if (['appearance', 'general', 'tools', 'policy', 'teams'].includes(section)) activeTab.value = section;
  await nextTick();
  const setting = String(route.query.setting ?? '');
  if (setting) Array.from(document.querySelectorAll('h3')).find(el => el.textContent?.includes(setting))?.scrollIntoView({ block: 'center' });
}, { immediate: true });
</script>

<template>
  <div class="settings-page">
    <Card data-surface="context-panel" class="settings-page-panel">
      <CardHeader class="flex shrink-0 flex-row items-center">
        <Button
          variant="ghost"
          size="icon-md"
          :title="hostKind ? '返回通用设置' : '返回'"
          :aria-label="hostKind ? '返回通用设置' : '返回'"
          @click="hostKind ? closeHostDetail() : emit('close')"
        >
          <ArrowLeft />
        </Button>
        <div class="min-w-0 flex-1">
          <h1 class="text-2xl font-semibold tracking-tight">设置</h1>
        </div>
      </CardHeader>
      <CardContent class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain">
        <HostDetailPanel v-if="hostKind" :kind="hostKind" @back="closeHostDetail" />
        <Tabs v-else v-model="activeTab" class="flex min-h-0 flex-col gap-6">
          <!-- 药丸组按内容宽换行:tab 数量变化不再撑破网格。 -->
          <TabsList size="sm" class="sticky top-0 z-10 flex h-auto w-fit max-w-full flex-wrap gap-1">
            <TabsTrigger value="appearance" class="flex-none">外观</TabsTrigger>
            <TabsTrigger value="general" class="flex-none">通用</TabsTrigger>
            <TabsTrigger value="tools" class="flex-none">工具</TabsTrigger>
            <TabsTrigger value="policy" class="flex-none">模型策略</TabsTrigger>
            <TabsTrigger value="teams" class="flex-none">团队管理</TabsTrigger>
          </TabsList>
          <TabsContent value="appearance" class="flex flex-col gap-6">
            <AppearanceTab />
          </TabsContent>
          <TabsContent value="general" class="flex flex-col gap-6">
            <GeneralTab @open-host-detail="openHostDetail" />
          </TabsContent>
          <TabsContent value="tools" class="flex flex-col gap-6">
            <ToolsTab />
          </TabsContent>
          <TabsContent value="policy" class="flex flex-col gap-6">
            <PolicyTab :policy="props.policy" :defaults="props.defaults" @saved="emit('saved', $event)" />
          </TabsContent>
          <TabsContent value="teams" class="flex flex-col gap-6">
            <TeamsTab :archived-teams="props.archivedTeams ?? []" @restore-team="emit('restoreTeam', $event)" />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  </div>
</template>
