<script setup lang="ts">
import HomeWorkbench from '@/features/productivity/HomeWorkbench.vue';
import { Disclosure } from '@/components/ui/disclosure';
import TelemetryOverview from '@/features/telemetry/TelemetryOverview.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from '@/components/ui/item';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from '@/components/ui/empty';
import { computed, ref, watch, type ComponentPublicInstance } from 'vue';
import {
  Bot,
  Folder,
  LoaderCircle,
  Pin,
  Radio,
  Search,
  X,
  Users,
} from '@lucide/vue';
import type { Group, Member, SessionEndpoint } from '@/shared/api/raw-types';
import { Badge } from '@/components/ui/badge';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from '@/components/ui/input-group';
import { Button } from '@/components/ui/button';

import { ScrollArea } from '@/components/ui/scroll-area';
import { useTeamOrganization } from '@/stores/team-organization';
import type { DropAxis } from '@/shared/drag-order';
import { withGap, type SortItem } from '@/shared/sort-preview';
import { useSortable } from '@/shared/use-sortable';

function workspaceLabel(workspace: string) {
  return workspace.split(/[\\/]/).filter(Boolean).slice(-2).join(' / ');
}

const props = defineProps<{
  groups: Group[];
  members: Member[];
  runningByGroup: Record<string, number>;
  runningEndpoints: string[];
  loading?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  retry: [];
}>();

const teamsOpen = ref(false);
const organization = useTeamOrganization();
const sortedGroups = computed(() =>
  [...props.groups].sort((left, right) => {
    const pinOrder =
      Number(organization.homePinned.includes(right.id)) -
      Number(organization.homePinned.includes(left.id));
    if (pinOrder) return pinOrder;
    const leftIndex = organization.homeOrder.indexOf(left.id);
    const rightIndex = organization.homeOrder.indexOf(right.id);
    return (
      (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) -
      (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
    );
  }),
);
const memberCount = computed(
  () => props.members.filter((member) => !member.removed).length,
);
const runningCount = computed(() => props.runningEndpoints.length);
const pinnedCount = computed(
  () =>
    props.groups.filter((group) => organization.homePinned.includes(group.id))
      .length,
);

function memberCountFor(groupId: string) {
  return props.members.filter(
    (member) => member.group_id === groupId && !member.removed,
  ).length;
}

function runningCountFor(groupId: string) {
  return props.runningByGroup[groupId] ?? 0;
}

function folderNameFor(groupId: string) {
  const folderId = organization.teams[groupId]?.folder;
  return organization.folders.find((folder) => folder.id === folderId)?.name;
}

function isHomePinned(groupId: string) {
  return organization.homePinned.includes(groupId);
}

function homeDropAxis(): DropAxis {
  return window.matchMedia('(max-width: 760px)').matches ? 'y' : 'x';
}

const search = ref('');
watch(search, () => { teamsOpen.value = true; });
const visibleGroups = computed(() => {
  const term = search.value.trim().toLocaleLowerCase();
  return sortedGroups.value.filter(
    (group) =>
      !term ||
      `${group.name} ${group.workspace} ${folderNameFor(group.id) ?? ''}`
        .toLocaleLowerCase()
        .includes(term),
  );
});

type HomeRow = SortItem<Group>;

const gridRoot = ref<HTMLElement | null>(null);
const sortable = useSortable({
  root: gridRoot,
  ids: () => visibleGroups.value.map((group) => group.id),
  canDrag: (id) => !search.value.trim() && !isHomePinned(id),
  canTarget: (id) => !isHomePinned(id),
  axis: homeDropAxis,
  onReorder: (id, targetId, after) =>
    organization.reorderHomeTeams(
      [id],
      targetId,
      after,
      props.groups.map((group) => group.id),
    ),
});
const cardRows = computed(() =>
  withGap(visibleGroups.value, sortable.preview.value, sortable.draggingIds.value),
);
const gapStyle = computed(() => {
  const size = sortable.preview.value?.size ?? 0;
  return homeDropAxis() === 'x'
    ? { width: `${size}px`, height: 'auto' }
    : { height: `${size}px` };
});

function attachCard(row: HomeRow, element: Element | ComponentPublicInstance | null) {
  if (!row.item) return;
  const root = element instanceof HTMLElement
    ? element
    : element && '$el' in element
      ? element.$el
      : null;
  sortable.bindItem(row.item.id, root instanceof HTMLElement ? root : null);
}
function selectCard(row: HomeRow) {
  if (row.item) emit('select', row.item.id);
}
function togglePinCard(row: HomeRow) {
  if (row.item) organization.toggleHomePin(row.item.id);
}
function isPinnedCard(row: HomeRow) {
  return row.item ? isHomePinned(row.item.id) : false;
}
function pinnedLabel(row: HomeRow) {
  return isPinnedCard(row) ? '取消首页置顶团队' : '首页置顶团队';
}
function memberCountCard(row: HomeRow) {
  return row.item ? memberCountFor(row.item.id) : 0;
}
function runningCountCard(row: HomeRow) {
  return row.item ? runningCountFor(row.item.id) : 0;
}
function folderNameCard(row: HomeRow) {
  return row.item ? folderNameFor(row.item.id) : undefined;
}
function bindGapRef(element: Element | ComponentPublicInstance | null) {
  sortable.bindGap(element instanceof HTMLElement ? element : null);
}
</script>

<template>
  <!-- 页面本身不是卡片:卡片留给页面里的独立区块,避免"卡片套卡片"。 -->
  <div class="team-home min-w-0">
    <div class="team-home-inner">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <h1 class="text-2xl font-semibold tracking-tight">团队</h1>
        <Button as-child><RouterLink to="/groups/new">创建团队</RouterLink></Button>
      </header>

      <HomeWorkbench>
        <template #actions>
          <Button as-child variant="outline" size="icon-sm">
            <RouterLink
              :to="{ name: 'panel-agent' }"
              aria-label="打开 Panel Agent"
              title="打开 Panel Agent"
              ><Bot
            /></RouterLink>
          </Button>
        </template>
      </HomeWorkbench>
      <TelemetryOverview @select="emit('select', $event)" />

      <Alert v-if="error" variant="destructive"
        ><AlertDescription class="flex items-center gap-2"
          ><span class="flex-1">{{ error }}</span
          ><Button variant="outline" size="sm" @click="emit('retry')"
            >重试</Button
          ></AlertDescription
        ></Alert
      >

      <section aria-labelledby="team-home-list-title">
        <Disclosure :heading-level="2" v-model:open="teamsOpen" >
<template #summary><span id="team-home-list-title">团队目录</span><Badge v-if="pinnedCount" variant="secondary"><Pin />{{ pinnedCount }} 个置顶</Badge></template>
<template #actions><InputGroup class="w-full sm:w-64 sm:ml-auto">
              <InputGroupAddon><Search /></InputGroupAddon>
              <InputGroupInput
                v-model="search"
                placeholder="搜索团队或工作区"
                aria-label="搜索团队或工作区"
              />
              <InputGroupAddon v-if="search" align="inline-end">
                <InputGroupButton size="icon-xs" aria-label="清空搜索" @click="search = ''"><X /></InputGroupButton>
              </InputGroupAddon>
            </InputGroup></template>

            <Empty v-if="loading || !groups.length">
              <EmptyHeader
                ><EmptyMedia variant="icon"
                  ><LoaderCircle v-if="loading" class="animate-spin" /><Users
                    v-else /></EmptyMedia
                ><EmptyTitle>{{
                  loading ? '正在读取团队' : '还没有团队'
                }}</EmptyTitle
                ><EmptyDescription v-if="!loading"
                  >创建团队，安排几位助手一起完成工作。</EmptyDescription
                ></EmptyHeader
              >
            </Empty>
            <Empty v-else-if="!visibleGroups.length"
              ><EmptyHeader
                ><EmptyMedia variant="icon"><Search /></EmptyMedia
                ><EmptyTitle>没有匹配的团队</EmptyTitle
                ><EmptyDescription
                  >换个名称、文件夹或工作区试试。</EmptyDescription
                ></EmptyHeader>
                <EmptyContent><Button variant="outline" size="sm" @click="search = ''">清空搜索</Button></EmptyContent>
              </Empty>
            <ScrollArea
              v-else
              class="w-full"
              item-selector=".team-home-card"
              :max-visible-items="10"
              aria-label="全部团队列表"
            >
              <div ref="gridRoot">
                <ItemGroup class="team-home-grid">
                  <template v-for="row in cardRows" :key="row.key">
                    <Item
                      v-if="row.item"
                      :ref="el => attachCard(row, el)"
                      variant="outline"
                      class="team-home-card flex-nowrap"
                      data-component="content-surface"
                      :data-flip-key="`home:${row.item.id}`"
                      :data-sort-hidden="row.hidden ? 'true' : undefined"
                      :title="
                        isPinnedCard(row)
                          ? '已置顶团队固定在前面'
                          : '拖动调整首页排序'
                      "
                    >
                      <ItemContent>
                        <button
                          type="button"
                          class="flex min-w-0 flex-col gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          @click="selectCard(row)"
                        >
                          <span class="flex min-w-0 flex-col gap-1">
                            <ItemTitle>{{ row.item.name }}</ItemTitle>
                            <ItemDescription :title="row.item.workspace">{{
                              workspaceLabel(row.item.workspace)
                            }}</ItemDescription>
                          </span>
                          <span class="flex flex-wrap items-center gap-2">
                            <span class="text-xs text-muted-foreground"
                              >{{ memberCountCard(row) }} 名成员</span
                            >
                            <Badge
                              v-if="runningCountCard(row)"
                              variant="secondary"
                              ><Radio />{{ runningCountCard(row) }}
                              个运行中</Badge
                            >
                            <Badge
                              v-if="folderNameCard(row)"
                              variant="outline"
                              ><Folder />{{ folderNameCard(row) }}</Badge
                            >
                          </span>
                        </button>
                      </ItemContent>
                      <ItemActions>
                        <Button
                          type="button"
                          size="icon-sm"
                          :variant="isPinnedCard(row) ? 'secondary' : 'ghost'"
                          :aria-label="pinnedLabel(row)"
                          :aria-pressed="isPinnedCard(row)"
                          @click="togglePinCard(row)"
                          ><Pin
                        /></Button>
                      </ItemActions>
                    </Item>
                    <div
                      v-else
                      class="team-home-gap"
                      :ref="bindGapRef"
                      aria-hidden="true"
                      :style="gapStyle"
                    />
                  </template>
                </ItemGroup>
              </div>
            </ScrollArea>

</Disclosure>
      </section>
    </div>
  </div>
</template>
