<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  FolderPlus,
  Pin,
  Plus,
  Search,
  X,
} from '@lucide/vue';
import type { Group, Member } from '@/shared/api/raw-types';
import { Surface } from '@/components/surface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CollapseReveal } from '@/components/ui/collapse-reveal';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { teamAvatarColor } from '@/features/layout/team-activity';
import { useTeamSecondaryPanel } from '@/features/layout/use-team-secondary-panel';
import TeamMenu from './TeamMenu.vue';

const props = withDefaults(
  defineProps<{
    groups: Group[];
    members?: Member[];
    currentGroupId?: string;
    groupUnreadByTeam?: ReadonlyMap<string, number>;
    activityByTeam?: ReadonlyMap<string, number>;
  }>(),
  {
    members: () => [],
  },
);

const emit = defineEmits<{
  select: [id: string];
  createTeam: [];
  archive: [ids: string[]];
  collapse: [];
}>();

const {
  org,
  searchQuery,
  segment,
  SEGMENTS,
  creatingFolder,
  newFolderName,
  renamingFolder,
  hasQuery,
  filteredGroups,
  pinnedTeams,
  ungroupedTeams,
  visibleFolders,
  recentList,
  teamsInFolder,
  memberCountFor,
  unreadFor,
  unreadLabel,
  activeLabelFor,
  showPinnedSection,
  showFoldersSection,
  showUngroupedSection,
  isFolderExpanded,
  isSectionExpanded,
  selected,
  clearSelection,
  selectTeam,
  selectRecentTeam,
  requestArchiveFor,
  allSelectedPinned,
  togglePinSelected,
  archiveSelected,
  toggleFolder,
  toggleSection,
  submitCreateFolder,
  beginRenameFolder,
  submitRenameFolder,
  bindTeamRow,
  bindFolderHeading,
  bindFolderBlock,
  bindPinnedZone,
  bindRootZone,
  dragging,
  draggingIds,
  containerDropZone,
} = useTeamSecondaryPanel({
  props,
  emit: {
    select: id => emit('select', id),
    archive: ids => emit('archive', ids),
  },
});

const refBinders = new Map<string, (element: Element | ComponentPublicInstance | null) => void>();
function stableRef(
  key: string,
  bind: (element: Element | null, previous?: Element | null) => void,
) {
  let fn = refBinders.get(key);
  if (!fn) {
    let current: Element | null = null;
    fn = (element) => {
      if (element instanceof HTMLElement) {
        current = element;
        bind(element);
        return;
      }
      const previous = current;
      current = null;
      bind(null, previous);
    };
    refBinders.set(key, fn);
  }
  return fn;
}

const pinnedZoneRef = stableRef('pinned', bindPinnedZone);
const rootZoneRef = stableRef('root', bindRootZone);

function teamCardRef(id: string) {
  return stableRef(`team:${id}`, (el, prev) => bindTeamRow(id, el, prev));
}

function folderBlockRef(id: string) {
  return stableRef(`folder-block:${id}`, (el, prev) => bindFolderBlock(id, el, prev));
}

function folderHeadingRef(id: string) {
  return stableRef(`folder-heading:${id}`, (el, prev) => bindFolderHeading(id, el, prev));
}

</script>

<template>
  <div class="secondary-panel" data-testid="team-secondary-panel">
    <!-- 标题行：团队 + 数量 + 新建文件夹 / + 新建 -->
    <div class="flex items-center justify-between gap-2 px-1">
      <div class="flex min-w-0 items-baseline gap-1.5">
        <h2 class="truncate text-sm font-semibold tracking-tight text-foreground">团队</h2>
        <span class="text-xs text-muted-foreground tabular-nums">{{ groups.length }}</span>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="新建团队文件夹"
              title="新建文件夹"
              @click="creatingFolder = !creatingFolder"
            >
              <FolderPlus class="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">新建文件夹</TooltipContent>
        </Tooltip>
        <Button
          variant="secondary"
          size="sm"
          class="h-7 gap-1 px-2 text-xs"
          aria-label="新建团队"
          @click="emit('createTeam')"
        >
          <Plus class="size-3.5" />
          新建
        </Button>
      </div>
    </div>

    <!-- 新建文件夹表单 -->
    <form
      v-if="creatingFolder"
      class="mt-2 flex flex-col gap-2 px-1"
      @submit.prevent="submitCreateFolder"
    >
      <Input
        v-model="newFolderName"
        size="sm"
        aria-label="文件夹名称"
        placeholder="文件夹名称"
        maxlength="60"
        @keydown.esc="creatingFolder = false"
      />
      <div class="flex gap-1.5">
        <Button size="xs" type="submit">创建</Button>
        <Button size="xs" variant="ghost" type="button" @click="creatingFolder = false">取消</Button>
      </div>
    </form>

    <!-- 搜索框 -->
    <div class="relative mt-2.5 px-1">
      <Search class="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        v-model="searchQuery"
        size="sm"
        class="pl-7 pr-7"
        placeholder="搜索团队、成员..."
        aria-label="搜索团队或成员"
      />
      <button
        v-if="hasQuery"
        type="button"
        class="absolute top-1/2 right-2.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-(--component-chip-radius) text-muted-foreground hover:text-foreground"
        aria-label="清除搜索"
        @click="searchQuery = ''"
      >
        <X class="size-3" />
      </button>
    </div>

    <!-- 分段筛选：全部 / 置顶 / 文件夹 / 未分组 -->
    <Tabs v-model="segment" class="gap-0">
      <TabsList
        size="xs"
        aria-label="团队分组筛选"
        class="mt-2.5 grid w-full grid-cols-4 gap-0.5 rounded-(--component-control-radius) bg-muted/50"
      >
        <TabsTrigger
          v-for="tab in SEGMENTS"
          :key="tab.id"
          :value="tab.id"
        >
          {{ tab.label }}
        </TabsTrigger>
      </TabsList>
    </Tabs>

    <!-- 最近访问（仅在「全部」标签页出现；横向滚动，复用项目共享滚动条） -->
    <div v-if="segment === 'all' && !hasQuery && recentList.length" class="mt-3 px-1">
      <div class="text-2xs font-medium text-muted-foreground">最近访问</div>
      <div
        class="recent-teams-strip scrollbar-thin mt-1.5 flex items-center gap-2 overflow-x-auto pb-1.5"
        aria-label="最近访问团队"
      >
        <Tooltip v-for="team in recentList" :key="team.id">
          <TooltipTrigger as-child>
            <button
              type="button"
              class="recent-team-avatar"
              :data-current="team.id === currentGroupId ? 'true' : undefined"
              :aria-label="`打开团队 ${team.name}`"
              :title="team.name"
              :style="{ backgroundColor: teamAvatarColor(team.id, org.teams[team.id]?.color) }"
              @click="selectRecentTeam(team.id)"
            >
              {{ team.name.slice(0, 1) }}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{{ team.name }}</TooltipContent>
        </Tooltip>
      </div>
    </div>

    <!-- 多选批量操作条：支持拖动选中项入文件夹、批量置顶与批量归档 -->
    <div
      v-if="selected.length > 1"
      data-batch-toolbar="true"
      class="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-(--component-chip-radius) bg-muted/60 px-2.5 py-1.5 text-xs"
    >
      <span class="truncate text-foreground tabular-nums">已选 {{ selected.length }} 个团队</span>
      <div class="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          class="h-6 gap-1 px-1.5 text-xs"
          :aria-label="allSelectedPinned ? '批量取消置顶已选团队' : '批量置顶已选团队'"
          @click="togglePinSelected"
        >
          <Pin class="size-3.5" />
          {{ allSelectedPinned ? '取消置顶' : '置顶' }}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          class="h-6 gap-1 px-1.5 text-xs"
          aria-label="批量归档已选团队"
          @click="archiveSelected"
        >
          <Archive class="size-3.5" />
          归档
        </Button>
        <Button
          size="sm"
          variant="ghost"
          class="h-6 px-1.5 text-xs text-muted-foreground"
          aria-label="取消多选"
          @click="clearSelection"
        >
          取消
        </Button>
      </div>
    </div>

    <!-- 团队列表（统一文件夹语义：置顶 → 文件夹按名称 → 未分组；组内按活跃时间） -->
    <nav
      class="team-navigation mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-0.5 pb-14"
      :data-multi-select="selected.length > 1 ? 'true' : undefined"
      aria-label="团队列表"
    >
      <!-- 置顶（「全部」视图支持收起/展开并持久化；独立筛选页直接展示） -->
      <section
        v-if="showPinnedSection"
        :ref="pinnedZoneRef"
        class="team-group-section"
        :class="{ 'team-folder-collapsed': !isSectionExpanded('pinned') }"
        data-section-kind="pinned"
        :data-drop-container="containerDropZone('pinned')"
      >
        <div v-if="segment === 'all'" class="team-folder-row">
          <button
            type="button"
            class="team-folder-trigger"
            :aria-expanded="isSectionExpanded('pinned')"
            aria-controls="sidebar-section-pinned"
            @click="toggleSection('pinned')"
          >
            <component :is="isSectionExpanded('pinned') ? ChevronDown : ChevronRight" class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="truncate">置顶</span>
            <span class="text-muted-foreground">·</span>
            <span class="text-muted-foreground tabular-nums">{{ pinnedTeams.length }}</span>
          </button>
        </div>
        <div v-else class="team-section-heading">
          <span class="truncate">置顶</span>
          <span class="text-muted-foreground">·</span>
          <span class="text-muted-foreground tabular-nums">{{ pinnedTeams.length }}</span>
        </div>
        <CollapseReveal id="sidebar-section-pinned" :show="isSectionExpanded('pinned')">
          <div class="team-card-list">
            <div
              v-for="team in pinnedTeams"
              :key="team.id"
              :ref="teamCardRef(team.id)"
              class="team-row team-card-wrap"
              :class="{ 'team-row-selected': selected.includes(team.id) }"
              :data-team-id="team.id"
              :data-dragging="draggingIds.includes(team.id) ? 'true' : undefined"
            >
              <button
                type="button"
                class="team-card"
                :data-current="team.id === currentGroupId ? 'true' : undefined"
                :data-selected="selected.includes(team.id) ? 'true' : undefined"
                :aria-current="team.id === currentGroupId ? 'page' : undefined"
                :aria-pressed="selected.includes(team.id)"
                :title="team.name"
                @click="selectTeam(team.id, $event)"
              >
                <span
                  class="team-card-avatar"
                  :style="{ backgroundColor: teamAvatarColor(team.id, org.teams[team.id]?.color) }"
                  aria-hidden="true"
                >{{ team.name.slice(0, 1) }}</span>
                <span class="min-w-0 flex-1 text-left">
                  <span class="block truncate text-sm font-medium leading-tight text-foreground">{{ team.name }}</span>
                  <span class="mt-0.5 block truncate text-2xs text-muted-foreground">
                    {{ memberCountFor(team.id) }} 位成员 · {{ activeLabelFor(team) }}
                  </span>
                </span>
                <Badge
                  v-if="unreadFor(team.id) > 0"
                  variant="default"
                  class="shrink-0 tabular-nums"
                  :aria-label="`${unreadFor(team.id)} 条未读`"
                >{{ unreadLabel(unreadFor(team.id)) }}</Badge>
              </button>
              <div class="team-card-menu">
                <TeamMenu
                  :id="team.id"
                  :name="team.name"
                  :archived="team.state === 'archived'"
                  @archive="requestArchiveFor(team.id)"
                />
              </div>
            </div>
          </div>
        </CollapseReveal>
      </section>

      <!-- 文件夹（按名称排序） -->
      <template v-if="showFoldersSection">
        <section
          v-for="folder in visibleFolders"
          :key="folder.id"
          :ref="folderBlockRef(folder.id)"
          class="team-group-section team-folder"
          :class="{ 'team-folder-collapsed': !isFolderExpanded(folder) }"
          data-section-kind="folder"
          :data-folder-id="folder.id"
          :data-drop-container="containerDropZone(`folder:${folder.id}`)"
        >
          <div :ref="folderHeadingRef(folder.id)" class="team-folder-row">
            <button
              type="button"
              class="team-folder-trigger"
              :aria-expanded="isFolderExpanded(folder)"
              :aria-controls="`sidebar-folder-${folder.id}`"
              @click="toggleFolder(folder.id)"
            >
              <component :is="isFolderExpanded(folder) ? ChevronDown : ChevronRight" class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="truncate">{{ folder.name }}</span>
              <span class="text-muted-foreground">·</span>
              <span class="text-muted-foreground tabular-nums">{{ teamsInFolder(folder.id).length }}</span>
            </button>
            <TeamMenu
              :id="folder.id"
              :name="folder.name"
              folder
              @rename="beginRenameFolder(folder.id, folder.name)"
            />
          </div>

          <form
            v-if="renamingFolder?.id === folder.id"
            class="my-1 ml-3 flex flex-col gap-1.5"
            @submit.prevent="submitRenameFolder"
          >
            <Input
              v-model="renamingFolder.name"
              size="sm"
              :aria-label="`重命名文件夹 ${folder.name}`"
              maxlength="60"
              @keydown.esc="renamingFolder = undefined"
            />
            <div class="flex gap-1.5">
              <Button size="xs" type="submit">保存</Button>
              <Button size="xs" variant="ghost" type="button" @click="renamingFolder = undefined">取消</Button>
            </div>
          </form>

          <CollapseReveal :id="`sidebar-folder-${folder.id}`" :show="isFolderExpanded(folder)">
            <div class="team-card-list team-folder-cards">
              <div
                v-for="team in teamsInFolder(folder.id)"
                :key="team.id"
                :ref="teamCardRef(team.id)"
                class="team-row team-card-wrap"
                :class="{ 'team-row-selected': selected.includes(team.id) }"
                :data-team-id="team.id"
                :data-dragging="draggingIds.includes(team.id) ? 'true' : undefined"
              >
                <button
                  type="button"
                  class="team-card"
                  :data-current="team.id === currentGroupId ? 'true' : undefined"
                  :data-selected="selected.includes(team.id) ? 'true' : undefined"
                  :aria-current="team.id === currentGroupId ? 'page' : undefined"
                  :aria-pressed="selected.includes(team.id)"
                  :title="team.name"
                  @click="selectTeam(team.id, $event)"
                >
                  <span
                    class="team-card-avatar"
                    :style="{ backgroundColor: teamAvatarColor(team.id, org.teams[team.id]?.color) }"
                    aria-hidden="true"
                  >{{ team.name.slice(0, 1) }}</span>
                  <span class="min-w-0 flex-1 text-left">
                    <span class="block truncate text-sm font-medium leading-tight text-foreground">{{ team.name }}</span>
                    <span class="mt-0.5 block truncate text-2xs text-muted-foreground">
                      {{ memberCountFor(team.id) }} 位成员 · {{ activeLabelFor(team) }}
                    </span>
                  </span>
                  <Badge
                    v-if="unreadFor(team.id) > 0"
                    variant="default"
                    class="shrink-0 tabular-nums"
                    :aria-label="`${unreadFor(team.id)} 条未读`"
                  >{{ unreadLabel(unreadFor(team.id)) }}</Badge>
                </button>
                <div class="team-card-menu">
                  <TeamMenu
                    :id="team.id"
                    :name="team.name"
                    :archived="team.state === 'archived'"
                    @archive="requestArchiveFor(team.id)"
                  />
                </div>
              </div>
              <p
                v-if="dragging === 'team' && !teamsInFolder(folder.id).length"
                class="m-1 flex min-h-10 items-center justify-center rounded-(--component-chip-radius) border border-dashed border-border px-3 text-xs text-muted-foreground"
              >
                拖入团队
              </p>
            </div>
          </CollapseReveal>
        </section>
      </template>

      <!-- 未分组（「全部」视图支持收起/展开并持久化；独立筛选页直接展示） -->
      <section
        v-if="showUngroupedSection"
        :ref="rootZoneRef"
        class="team-group-section team-root-drop"
        :class="{ 'team-folder-collapsed': !isSectionExpanded('ungrouped') }"
        data-section-kind="ungrouped"
        :data-drop-container="containerDropZone('root')"
      >
        <div v-if="segment === 'all'" class="team-folder-row">
          <button
            type="button"
            class="team-folder-trigger"
            :aria-expanded="isSectionExpanded('ungrouped')"
            aria-controls="sidebar-section-ungrouped"
            @click="toggleSection('ungrouped')"
          >
            <component :is="isSectionExpanded('ungrouped') ? ChevronDown : ChevronRight" class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="truncate">未分组</span>
            <span class="text-muted-foreground">·</span>
            <span class="text-muted-foreground tabular-nums">{{ ungroupedTeams.length }}</span>
          </button>
        </div>
        <div v-else class="team-section-heading">
          <span class="truncate">未分组</span>
          <span class="text-muted-foreground">·</span>
          <span class="text-muted-foreground tabular-nums">{{ ungroupedTeams.length }}</span>
        </div>
        <CollapseReveal id="sidebar-section-ungrouped" :show="isSectionExpanded('ungrouped')">
          <div class="team-card-list">
            <div
              v-for="team in ungroupedTeams"
              :key="team.id"
              :ref="teamCardRef(team.id)"
              class="team-row team-card-wrap"
              :class="{ 'team-row-selected': selected.includes(team.id) }"
              :data-team-id="team.id"
              :data-dragging="draggingIds.includes(team.id) ? 'true' : undefined"
            >
              <button
                type="button"
                class="team-card"
                :data-current="team.id === currentGroupId ? 'true' : undefined"
                :data-selected="selected.includes(team.id) ? 'true' : undefined"
                :aria-current="team.id === currentGroupId ? 'page' : undefined"
                :aria-pressed="selected.includes(team.id)"
                :title="team.name"
                @click="selectTeam(team.id, $event)"
              >
                <span
                  class="team-card-avatar"
                  :style="{ backgroundColor: teamAvatarColor(team.id, org.teams[team.id]?.color) }"
                  aria-hidden="true"
                >{{ team.name.slice(0, 1) }}</span>
                <span class="min-w-0 flex-1 text-left">
                  <span class="block truncate text-sm font-medium leading-tight text-foreground">{{ team.name }}</span>
                  <span class="mt-0.5 block truncate text-2xs text-muted-foreground">
                    {{ memberCountFor(team.id) }} 位成员 · {{ activeLabelFor(team) }}
                  </span>
                </span>
                <Badge
                  v-if="unreadFor(team.id) > 0"
                  variant="default"
                  class="shrink-0 tabular-nums"
                  :aria-label="`${unreadFor(team.id)} 条未读`"
                >{{ unreadLabel(unreadFor(team.id)) }}</Badge>
              </button>
              <div class="team-card-menu">
                <TeamMenu
                  :id="team.id"
                  :name="team.name"
                  :archived="team.state === 'archived'"
                  @archive="requestArchiveFor(team.id)"
                />
              </div>
            </div>
            <p
              v-if="dragging === 'team' && !ungroupedTeams.length"
              class="m-1 flex min-h-10 items-center justify-center rounded-(--component-chip-radius) border border-dashed border-border px-3 text-xs text-muted-foreground"
            >
              拖入未分组
            </p>
          </div>
        </CollapseReveal>
      </section>

      <!-- 空态 -->
      <p
        v-if="!groups.length"
        class="px-2 py-4 text-xs text-muted-foreground"
      >
        还没有团队。可点击右上「新建」创建。
      </p>
      <p
        v-else-if="hasQuery && !filteredGroups.length"
        class="px-2 py-4 text-xs text-muted-foreground"
      >
        没有匹配的团队或成员。
      </p>
      <p
        v-else-if="segment === 'folders' && !visibleFolders.length"
        class="px-2 py-4 text-xs text-muted-foreground"
      >
        还没有文件夹。可点击右上文件夹图标新建。
      </p>
      <p
        v-else-if="segment === 'pinned' && !pinnedTeams.length && dragging !== 'team'"
        class="px-2 py-4 text-xs text-muted-foreground"
      >
        还没有置顶团队。
      </p>
      <p
        v-else-if="segment === 'ungrouped' && !ungroupedTeams.length && dragging !== 'team'"
        class="px-2 py-4 text-xs text-muted-foreground"
      >
        没有未分组团队。
      </p>
    </nav>

    <!-- 右下角浮动收起按钮：复用 overlay 表面，由一级栏「团队」图标重新展开 -->
    <Surface role="overlay" class="secondary-panel-collapse-float">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="rounded-full text-muted-foreground hover:text-foreground"
            aria-label="收起团队面板"
            title="收起团队面板"
            data-testid="team-secondary-collapse-btn"
            @click="emit('collapse')"
          >
            <ChevronsLeft class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">收起团队面板</TooltipContent>
      </Tooltip>
    </Surface>
  </div>
</template>
