<script setup lang="ts">
import TelemetryOverview from '@/features/telemetry/TelemetryOverview.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
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
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  ArrowUpRight,
  Bot,
  ChevronsUpDown,
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTeamOrganization } from '@/stores/team-organization';

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

const teamsOpen = ref(true);
const draggingId = ref<string>();
const dropInsertion = ref<{ id: string; after: boolean }>();
const settledId = ref<string>();
let settleTimer: ReturnType<typeof setTimeout> | undefined;
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

function startHomeDrag(groupId: string, event: DragEvent) {
  if (isHomePinned(groupId)) {
    event.preventDefault();
    return;
  }
  settledId.value = undefined;
  if (settleTimer) clearTimeout(settleTimer);
  draggingId.value = groupId;
  event.dataTransfer?.setData('application/x-agent-team-home-id', groupId);
  event.dataTransfer?.setData('text/plain', groupId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function overHomeCard(groupId: string, event: DragEvent) {
  if (
    !draggingId.value ||
    draggingId.value === groupId ||
    isHomePinned(groupId)
  ) {
    dropInsertion.value = undefined;
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const after = window.matchMedia('(max-width: 760px)').matches
    ? event.clientY > rect.top + rect.height / 2
    : event.clientX > rect.left + rect.width / 2;
  dropInsertion.value = { id: groupId, after };
}

function leaveHomeCard(groupId: string, event: DragEvent) {
  const element = event.currentTarget as HTMLElement;
  if (
    !element.contains(event.relatedTarget as Node | null) &&
    dropInsertion.value?.id === groupId
  ) {
    dropInsertion.value = undefined;
  }
}

function dropHomeCard(groupId: string, event: DragEvent) {
  if (!draggingId.value || isHomePinned(groupId)) return;
  event.preventDefault();
  event.stopPropagation();
  const movedId = draggingId.value;
  const after =
    dropInsertion.value?.id === groupId ? dropInsertion.value.after : false;
  organization.reorderHomeTeams(
    [movedId],
    groupId,
    after,
    props.groups.map((group) => group.id),
  );
  clearHomeDrag();
  settledId.value = movedId;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settledId.value = undefined;
    settleTimer = undefined;
  }, 620);
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

function moveHome(id: string, direction: number) {
  const ids = sortedGroups.value.filter(group => !isHomePinned(group.id)).map(group => group.id);
  const target = ids[ids.indexOf(id) + direction];
  if (target) organization.reorderHomeTeams([id], target, direction > 0, props.groups.map(group => group.id));
}
function canMoveHome(id: string, direction: number) {
  const ids = sortedGroups.value.filter(group => !isHomePinned(group.id)).map(group => group.id);
  return !isHomePinned(id) && !search.value.trim() && Boolean(ids[ids.indexOf(id) + direction]);
}
function clearHomeDrag() {
  draggingId.value = undefined;
  dropInsertion.value = undefined;
}

onBeforeUnmount(() => {
  if (settleTimer) clearTimeout(settleTimer);
});
</script>

<template>
  <div class="team-home">
    <div class="team-home-inner">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex flex-col gap-2">
          <h1 class="text-2xl font-semibold tracking-tight">团队</h1>
        </div>
        <Button as-child variant="outline">
          <RouterLink :to="{ name: 'panel-agent' }"
            ><Bot data-icon="inline-start" />打开 Panel Agent<ArrowUpRight
              data-icon="inline-end"
          /></RouterLink>
        </Button>
      </header>

      <TelemetryOverview @select="emit('select', $event)" />
      <Separator />

      <Alert v-if="error" variant="destructive"
        ><AlertDescription class="flex items-center gap-2"
          ><span class="flex-1">{{ error }}</span
          ><Button variant="outline" size="sm" @click="emit('retry')"
            >重试</Button
          ></AlertDescription
        ></Alert
      >

      <section aria-labelledby="team-home-list-title">
        <Collapsible v-model:open="teamsOpen" class="flex flex-col gap-4">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <h2 id="team-home-list-title" class="text-sm font-medium">
              团队目录
            </h2>
            <InputGroup class="w-full sm:w-64 sm:ml-auto">
              <InputGroupAddon><Search /></InputGroupAddon>
              <InputGroupInput
                v-model="search"
                placeholder="搜索团队或工作区"
                aria-label="搜索团队或工作区"
              />
              <InputGroupAddon v-if="search" align="inline-end">
                <InputGroupButton size="icon-xs" aria-label="清空搜索" @click="search = ''"><X /></InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <div class="flex items-center gap-2">
              <Badge v-if="pinnedCount" variant="secondary"
                ><Pin />{{ pinnedCount }} 个置顶</Badge
              >
              <CollapsibleTrigger as-child
                ><Button
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="teamsOpen ? '收起全部团队' : '展开全部团队'"
                  ><ChevronsUpDown /></Button
              ></CollapsibleTrigger>
            </div>
          </div>
          <CollapsibleContent>
            <Empty v-if="loading || !groups.length">
              <EmptyHeader
                ><EmptyMedia variant="icon"
                  ><LoaderCircle v-if="loading" class="animate-spin" /><Users
                    v-else /></EmptyMedia
                ><EmptyTitle>{{
                  loading ? '正在读取团队' : '还没有团队'
                }}</EmptyTitle
                ><EmptyDescription v-if="!loading"
                  >在 CLI 中创建团队后，会自动显示在这里。</EmptyDescription
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
              <ItemGroup class="team-home-grid">
                <Item
                  v-for="group in visibleGroups"
                  :key="group.id"
                  variant="outline"
                  class="team-home-card flex-nowrap"
                  :draggable="!search.trim() && !isHomePinned(group.id)"
                  :title="
                    isHomePinned(group.id)
                      ? '已置顶团队固定在前面'
                      : '拖动调整首页排序'
                  "
                  @dragstart="startHomeDrag(group.id, $event)"
                  @dragover="overHomeCard(group.id, $event)"
                  @dragleave="leaveHomeCard(group.id, $event)"
                  @drop="dropHomeCard(group.id, $event)"
                  @dragend="clearHomeDrag"
                >
                  <ItemContent>
                    <button
                      type="button"
                      class="flex min-w-0 flex-col gap-3 text-left"
                      @click="emit('select', group.id)"
                    >
                      <span class="flex min-w-0 flex-col gap-1">
                        <ItemTitle>{{ group.name }}</ItemTitle>
                        <ItemDescription :title="group.workspace">{{
                          workspaceLabel(group.workspace)
                        }}</ItemDescription>
                      </span>
                      <span class="flex flex-wrap items-center gap-2">
                        <span class="text-xs text-muted-foreground"
                          >{{ memberCountFor(group.id) }} 名成员</span
                        >
                        <Badge
                          v-if="runningCountFor(group.id)"
                          variant="secondary"
                          ><Radio />{{
                            runningCountFor(group.id)
                          }}
                          个运行中</Badge
                        >
                        <Badge v-if="folderNameFor(group.id)" variant="outline"
                          ><Folder />{{ folderNameFor(group.id) }}</Badge
                        >
                        <Badge
                          v-if="dropInsertion?.id === group.id"
                          variant="secondary"
                          >{{
                            dropInsertion.after ? '放在后面' : '放在前面'
                          }}</Badge
                        >
                      </span>
                    </button>
                  </ItemContent>
                  <ItemActions class="flex-wrap">
                    <Button variant="ghost" size="sm" :disabled="!canMoveHome(group.id, -1)" @click="moveHome(group.id, -1)">前移</Button>
                    <Button variant="ghost" size="sm" :disabled="!canMoveHome(group.id, 1)" @click="moveHome(group.id, 1)">后移</Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      :variant="isHomePinned(group.id) ? 'secondary' : 'ghost'"
                      :aria-label="
                        isHomePinned(group.id)
                          ? '取消首页置顶团队'
                          : '首页置顶团队'
                      "
                      :aria-pressed="isHomePinned(group.id)"
                      @dragstart.stop.prevent
                      @click="organization.toggleHomePin(group.id)"
                      ><Pin
                    /></Button>
                  </ItemActions>
                </Item>
              </ItemGroup>
            </ScrollArea>
          </CollapsibleContent>
        </Collapsible>
      </section>
    </div>
  </div>
</template>
