<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  ref,
} from 'vue';
import {
  ArrowUpRight,
  Bot,
  ChevronsUpDown,
  Clock3,
  Folder,
  LoaderCircle,
  Pin,
  Radio,
  Users,
} from '@lucide/vue';
import type { Group, Member, SessionEndpoint } from '@/shared/api/raw-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useTeamOrganization } from '@/stores/team-organization';

const props = defineProps<{
  groups: Group[];
  members: Member[];
  endpoints: SessionEndpoint[];
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
const sortedGroups = computed(() => [...props.groups].sort((left, right) => {
  const pinOrder = Number(organization.homePinned.includes(right.id))
    - Number(organization.homePinned.includes(left.id));
  if (pinOrder) return pinOrder;
  const leftIndex = organization.homeOrder.indexOf(left.id);
  const rightIndex = organization.homeOrder.indexOf(right.id);
  return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
    - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
}));
const memberCount = computed(() => props.members.filter(member => !member.removed).length);
const runningCount = computed(() => props.runningEndpoints.length);
const pinnedCount = computed(() => props.groups.filter(group => organization.homePinned.includes(group.id)).length);

function memberCountFor(groupId: string) {
  return props.members.filter(member => member.group_id === groupId && !member.removed).length;
}

function runningCountFor(groupId: string) {
  const endpointIds = new Set(
    props.endpoints
      .filter(endpoint => endpoint.group_id === groupId)
      .map(endpoint => endpoint.id),
  );
  return props.runningEndpoints.filter(id => endpointIds.has(id)).length;
}

function folderNameFor(groupId: string) {
  const folderId = organization.teams[groupId]?.folder;
  return organization.folders.find(folder => folder.id === folderId)?.name;
}

function colorFor(groupId: string) {
  return organization.teams[groupId]?.color;
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
  if (!draggingId.value || draggingId.value === groupId || isHomePinned(groupId)) {
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
  if (!element.contains(event.relatedTarget as Node | null) && dropInsertion.value?.id === groupId) {
    dropInsertion.value = undefined;
  }
}

function dropHomeCard(groupId: string, event: DragEvent) {
  if (!draggingId.value || isHomePinned(groupId)) return;
  event.preventDefault();
  event.stopPropagation();
  const movedId = draggingId.value;
  const after = dropInsertion.value?.id === groupId ? dropInsertion.value.after : false;
  organization.reorderHomeTeams(
    [movedId],
    groupId,
    after,
    props.groups.map(group => group.id),
  );
  clearHomeDrag();
  settledId.value = movedId;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settledId.value = undefined;
    settleTimer = undefined;
  }, 620);
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
      <header class="team-home-hero panel">
        <p class="eyebrow">TEAM OVERVIEW</p>
        <div class="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">团队总览</h1>
            <p class="mt-2 max-w-xl text-sm leading-6 text-muted">
              查看本机团队与运行状态。选择团队后进入消息、成员和协作详情。
            </p>
          </div>
          <Badge v-if="pinnedCount" variant="accent">
            <Pin :size="10" />
            {{ pinnedCount }} 个首页置顶
          </Badge>
        </div>

        <div class="team-home-stats">
          <div class="team-home-stat">
            <span class="team-home-stat-icon"><Users :size="16" /></span>
            <span>
              <strong>{{ groups.length }}</strong>
              <small>团队</small>
            </span>
          </div>
          <div class="team-home-stat">
            <span class="team-home-stat-icon"><Users :size="16" /></span>
            <span>
              <strong>{{ memberCount }}</strong>
              <small>成员</small>
            </span>
          </div>
          <div class="team-home-stat">
            <span class="team-home-stat-icon"><Radio :size="16" /></span>
            <span>
              <strong>{{ runningCount }}</strong>
              <small>运行中会话</small>
            </span>
          </div>
        </div>
      </header>

      <div v-if="error" class="error-banner" role="alert">
        <span class="min-w-0 flex-1">{{ error }}</span>
        <Button variant="outline" size="sm" @click="emit('retry')">重试</Button>
      </div>

      <div
        class="team-home-agent-entry"
      >
        <span class="agent-mark agent-mark-small">
          <Bot :size="16" />
        </span>
        <span class="team-home-agent-copy">
          <span class="eyebrow">PANEL AGENT</span>
          <strong>打开私人协作会话</strong>
          <small>直接询问团队状态、调度对话或准备新的团队。</small>
        </span>
        <RouterLink
          :to="{ name: 'panel-agent' }"
          class="team-home-agent-action"
        >
          进入 Agent
          <ArrowUpRight data-icon="inline-end" />
        </RouterLink>
      </div>

      <section class="team-home-teams">
        <Collapsible v-model:open="teamsOpen" class="team-home-teams-collapsible">
          <div class="team-home-section-header">
            <div>
              <h2 id="team-home-list-title" class="text-base font-semibold">全部团队</h2>
              <p class="mt-1 text-xs text-muted">点击团队卡片进入对应工作区。</p>
            </div>
            <div class="flex items-center gap-2">
              <Badge>{{ groups.length }} 个团队</Badge>
              <CollapsibleTrigger as-child>
                <Button
                  variant="ghost"
                  size="sm"
                  :aria-label="teamsOpen ? '收起全部团队' : '展开全部团队'"
                  :title="teamsOpen ? '收起全部团队' : '展开全部团队'"
                >
                  <span>{{ teamsOpen ? '收起' : '展开' }}</span>
                  <ChevronsUpDown data-icon="inline-end" />
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>

          <CollapsibleContent>
            <div class="team-home-teams-content">
              <div v-if="loading" class="team-home-empty panel">
                <LoaderCircle :size="20" class="animate-spin" />
                <p class="text-xs text-muted">正在读取团队…</p>
              </div>
              <div v-else-if="!groups.length" class="team-home-empty panel">
                <Users :size="24" />
                <div>
                  <h3 class="text-sm font-medium">还没有团队</h3>
                  <p class="mt-1 text-xs leading-5 text-muted">先在 CLI 中创建团队，完成后会自动显示在这里。</p>
                </div>
              </div>
              <TransitionGroup
                v-else
                name="team-home-card-motion"
                tag="div"
                class="team-home-grid"
              >
                <article
                  v-for="group in sortedGroups"
                  :key="group.id"
                  class="team-home-card"
                  :class="{
                    'team-home-card-dragging': draggingId === group.id,
                    'team-home-card-pinned': isHomePinned(group.id),
                    'team-home-card-drop-target': dropInsertion?.id === group.id,
                    'team-home-card-settled': settledId === group.id,
                    'team-insert-before': dropInsertion?.id === group.id && !dropInsertion.after,
                    'team-insert-after': dropInsertion?.id === group.id && dropInsertion.after,
                  }"
                  :draggable="!isHomePinned(group.id)"
                  :title="isHomePinned(group.id) ? '已置顶团队固定在前面' : '拖动调整首页排序'"
                  @dragstart="startHomeDrag(group.id, $event)"
                  @dragover="overHomeCard(group.id, $event)"
                  @dragleave="leaveHomeCard(group.id, $event)"
                  @drop="dropHomeCard(group.id, $event)"
                  @dragend="clearHomeDrag"
                >
                  <button
                    type="button"
                    class="team-home-card-link"
                    @click="emit('select', group.id)"
                  >
                    <span class="flex items-start gap-3">
                      <span
                        class="team-home-avatar"
                        :class="{ 'team-avatar-tagged': colorFor(group.id) }"
                        :style="colorFor(group.id) ? { '--tag-color': colorFor(group.id) } : undefined"
                      >
                        {{ group.name.slice(0, 1) }}
                      </span>
                      <span class="min-w-0 flex-1 text-left">
                        <strong class="block truncate text-sm">{{ group.name }}</strong>
                        <span class="mt-1 block truncate text-[11px] text-muted">{{ group.workspace }}</span>
                      </span>
                    </span>
                    <span class="mt-4 flex flex-wrap items-center gap-2">
                      <Badge variant="default">{{ memberCountFor(group.id) }} 名成员</Badge>
                      <Badge v-if="runningCountFor(group.id)" variant="accent">
                        <Radio :size="9" class="animate-pulse" />
                        {{ runningCountFor(group.id) }} 个运行中
                      </Badge>
                      <Badge v-if="folderNameFor(group.id)" variant="default">
                        <Folder :size="9" />
                        {{ folderNameFor(group.id) }}
                      </Badge>
                    </span>
                    <span class="mt-3 flex items-center gap-1 text-[10px] text-dim">
                      <Clock3 :size="10" />
                      {{ new Date(group.created).toLocaleString('zh-CN') }}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="team-home-pin"
                    :class="{ 'team-home-pin-active': organization.homePinned.includes(group.id) }"
                    :aria-label="organization.homePinned.includes(group.id) ? '取消首页置顶团队' : '首页置顶团队'"
                    :aria-pressed="organization.homePinned.includes(group.id)"
                    :title="organization.homePinned.includes(group.id) ? '取消首页置顶' : '首页置顶'"
                    @dragstart.stop.prevent
                    @click="organization.toggleHomePin(group.id)"
                  >
                    <Pin :size="15" :fill="organization.homePinned.includes(group.id) ? 'currentColor' : 'none'" />
                  </button>
                </article>
              </TransitionGroup>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </section>
    </div>
  </div>
</template>
