<script setup lang="ts">
import { useRoute } from 'vue-router';
import { nextTick, ref, watch } from 'vue';
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
        <Button variant="ghost" size="icon" title="返回" aria-label="返回" @click="emit('close')">
          <ArrowLeft />
        </Button>
        <div class="min-w-0 flex-1">
          <h1 class="text-2xl font-semibold tracking-tight">设置</h1>
        </div>
      </CardHeader>
      <CardContent class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain">
        <Tabs v-model="activeTab" class="flex min-h-0 flex-col gap-6">
          <!-- 药丸组按内容宽换行:tab 数量变化不再撑破网格。 -->
          <TabsList class="sticky top-0 z-10 flex h-auto w-fit max-w-full flex-wrap gap-1">
            <TabsTrigger value="appearance" class="flex-none px-2 text-xs sm:text-sm">外观</TabsTrigger>
            <TabsTrigger value="general" class="flex-none px-2 text-xs sm:text-sm">通用</TabsTrigger>
            <TabsTrigger value="tools" class="flex-none px-2 text-xs sm:text-sm">工具</TabsTrigger>
            <TabsTrigger value="policy" class="flex-none px-2 text-xs sm:text-sm">模型策略</TabsTrigger>
            <TabsTrigger value="teams" class="flex-none px-2 text-xs sm:text-sm">团队管理</TabsTrigger>
          </TabsList>
          <TabsContent value="appearance" class="flex flex-col gap-6">
            <AppearanceTab />
          </TabsContent>
          <TabsContent value="general" class="flex flex-col gap-6">
            <GeneralTab />
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
