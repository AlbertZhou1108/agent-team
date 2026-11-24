<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { computed, nextTick, ref, watch } from 'vue';
import { ArrowLeft } from '@lucide/vue';
import type { Group, ModelPolicy, ModelPolicyDefaults } from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { Surface } from '@/components/surface';
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

const SECTIONS = [
  { value: 'appearance', label: '外观' },
  { value: 'general', label: '通用与宿主集成' },
  { value: 'tools', label: '工具与扩展' },
  { value: 'policy', label: '模型策略' },
  { value: 'teams', label: '团队与归档管理' },
] as const;

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
    <div v-if="hostKind" class="settings-page-panel px-6 py-5 sm:px-8">
      <div class="mb-4 flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          title="返回通用设置"
          aria-label="返回通用设置"
          @click="closeHostDetail"
        >
          <ArrowLeft />
        </Button>
        <h1 class="text-lg font-semibold tracking-tight">设置 · 宿主详情</h1>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div class="mx-auto max-w-4xl pb-8">
          <HostDetailPanel :kind="hostKind" @back="closeHostDetail" />
        </div>
      </div>
    </div>

    <!-- 方案 A 全贴边双栏设置工作台（P07）：左二级导航栏 L0 + 右主内容面 L1，1px 发丝线分隔。 -->
    <Tabs
      v-else
      v-model="activeTab"
      orientation="vertical"
      class="settings-page-panel settings-page-panel-split gap-0"
    >
      <Surface
        role="nav-panel"
        as="aside"
        class="flex shrink-0 flex-col border-b border-border px-3 py-3 md:w-56 md:border-r md:border-b-0 md:py-5"
      >
        <div class="mb-3 flex items-center gap-1.5 px-1">
          <Button
            variant="ghost"
            size="icon-sm"
            title="返回"
            aria-label="返回"
            @click="emit('close')"
          >
            <ArrowLeft />
          </Button>
          <h1 class="text-base font-semibold tracking-tight text-foreground">设置</h1>
        </div>
        <TabsList
          size="sm"
          class="flex h-auto w-full flex-row flex-wrap gap-1 bg-transparent p-0 md:flex-col"
        >
          <TabsTrigger
            v-for="section in SECTIONS"
            :key="section.value"
            :value="section.value"
            class="settings-nav-trigger w-auto justify-start px-3 py-2 text-left text-sm md:w-full"
          >
            {{ section.label }}
          </TabsTrigger>
        </TabsList>
      </Surface>

      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6 sm:px-8">
        <div class="mx-auto flex max-w-4xl flex-col pb-10">
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
        </div>
      </div>
    </Tabs>
  </div>
</template>
