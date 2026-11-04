<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { usePanelAgentStore } from '@/stores/panel-agent';
import { useUiStore } from '@/stores/ui';
import CollapsibleRightSidebar from '@/app/layouts/CollapsibleRightSidebar.vue';
import type { PanelMessage, TeamRequest, PanelAgentState } from '@/shared/api/raw-types';
import {
  ArrowUpRight,
  Bell,
  CheckCheck,
  CircleAlert,
  MoreHorizontal,
  ShieldCheck,
  Users,
} from '@lucide/vue';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';
import PanelConfirmationItem from './PanelConfirmationItem.vue';
import type {
  PanelTeam,
  PanelUnknownTurn,
} from './types';

const props = defineProps<{
  teams: PanelTeam[];
  messages: PanelMessage[];
  requests: TeamRequest[];
  notifications: NonNullable<PanelAgentState['notifications']>;
  pendingInteractions: Record<string, number>;
  unknown: PanelUnknownTurn[];
}>();
const router = useRouter();
const panelState = usePanelAgentStore();
const ui = useUiStore();
const unread = (teamId: string) => panelState.unreadForContext(props.messages, teamId);
const hasUnread = computed(() => unread('') > 0 || panelState.unreadReceipts(props.requests) > 0);
const teamsOpen = ref(props.teams.length > 0);
const notificationsOpen = ref(false);
const teamsHeading = ref<HTMLElement | null>(null);
const notificationsHeading = ref<HTMLElement | null>(null);
const splitContainer = ref<HTMLElement | null>(null);
const teamsShare = ref(50);
const canResize = computed(() => teamsOpen.value && notificationsOpen.value);
let resizeStart: { y: number; share: number } | undefined;
function setTeamsShare(value: number) { teamsShare.value = Math.max(15, Math.min(85, value)); }
function beginTeamsResize(event: PointerEvent) {
  if (event.button !== 0 || !canResize.value) return;
  event.preventDefault();
  resizeStart = { y: event.clientY, share: teamsShare.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function moveTeamsResize(event: PointerEvent) {
  if (!resizeStart) return;
  const height = splitContainer.value?.clientHeight ?? 1;
  setTeamsShare(resizeStart.share + (event.clientY - resizeStart.y) / height * 100);
}
function resizeTeamsByKey(event: KeyboardEvent) {
  if (!canResize.value || !['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
  event.preventDefault();
  setTeamsShare(event.key === 'Home' ? 50 : teamsShare.value + (event.key === 'ArrowUp' ? -5 : 5));
}
const sidebarActions = [
  { value: 'teams', label: '团队关系', icon: Users },
  { value: 'notifications', label: '团队来源通知', icon: Bell },
];
async function openSidebarSection(section: string) {
  ui.contextCollapsed = false;
  ui.persist();
  if (section === 'teams') teamsOpen.value = true;
  else notificationsOpen.value = true;
  await nextTick();
  const heading = section === 'teams' ? teamsHeading.value : notificationsHeading.value;
  heading?.scrollIntoView({ block: 'nearest' });
  heading?.focus({ preventScroll: true });
}
watch(
  () => props.teams.length,
  (count) => {
    teamsOpen.value = count > 0;
  },
);
const activeTeamId = defineModel<string>({ required: true });
const emit = defineEmits<{
  openTeam: [teamId: string];
  takeover: [team: PanelTeam];
  handback: [team: PanelTeam];
  resolveRuntime: [turnId: string];
}>();

function selectTeam(teamId: string) {
  void router.push({ name: 'group', params: { groupId: teamId } });
}

function onTeamCardClick(teamId: string, event: MouseEvent) {
  if ((event.target as HTMLElement).closest('button')) return;
  selectTeam(teamId);
}
</script>

<template>
  <aside class="agent-side" aria-label="Panel Agent 团队信息">
  <CollapsibleRightSidebar v-model:collapsed="ui.contextCollapsed" :collapsed-actions="sidebarActions" @action="openSidebarSection" class="flex-1" @update:collapsed="ui.persist()">
    <div ref="splitContainer" class="panel-side-scroll flex min-h-0 flex-1 flex-col overflow-hidden px-4">
    <Disclosure :heading-level="2" v-model:open="teamsOpen" class="split-section" :style="{ flex: teamsOpen ? `${notificationsOpen ? teamsShare : 1} 1 0%` : '0 0 auto' }">
<template #summary><span ref="teamsHeading" tabindex="-1" class="flex items-center gap-2"><Users />团队关系</span><Badge>{{ teams.length }}</Badge></template>
<template #actions><Tooltip>
            <TooltipTrigger as-child>
              <span class="inline-flex" :tabindex="hasUnread ? undefined : 0" :aria-label="hasUnread ? undefined : '全部已读，当前没有未读消息'">
                <Button variant="ghost" size="icon-sm" :disabled="!hasUnread" aria-label="全部已读" @click="panelState.markAllPanelRead(messages.filter(message => message.active_team_id == null)); panelState.syncReceiptReads(requests, true)">
                  <CheckCheck />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>将全局私人会话和请求回执标为已读</TooltipContent>
          </Tooltip></template>
<div class="flex min-h-0 flex-1 flex-col gap-4">
        <ScrollArea
          class="w-full min-h-0"
          style="height: 100%"
          item-selector="[data-team-relation-item]"

          aria-label="团队关系列表"
        >
          <ItemGroup>
            <Item
              :variant="activeTeamId ? 'default' : 'muted'"
              size="sm"
              class="cursor-pointer flex-nowrap"
              @click="activeTeamId = ''"
            >
              <ItemMedia variant="icon">
                <Users />
              </ItemMedia>
              <ItemContent class="min-w-0">
                <button
                  type="button"
                  class="min-w-0 w-full text-left"
                  :aria-pressed="!activeTeamId"
                  @click="activeTeamId = ''"
                >
                  <ItemTitle class="w-full">全局助手</ItemTitle>
                </button>
              </ItemContent>
              <Badge v-if="unread('')" :aria-label="`${unread('')} 条未读消息`">{{ unread('') }}</Badge>
              <Badge
                :variant="activeTeamId ? 'default' : 'secondary'"
                class="shrink-0 whitespace-nowrap"
              >
                {{ activeTeamId ? `${teams.length} 个` : '当前' }}
              </Badge>
            </Item>
            <ItemSeparator />
            <Item
              v-for="team in teams"
              :key="team.id"
              data-team-relation-item
              :variant="activeTeamId === team.id ? 'muted' : 'default'"
              size="sm"
              class="cursor-pointer flex-nowrap"
              @click="onTeamCardClick(team.id, $event)"
            >
              <ItemMedia variant="icon">
                <Users />
              </ItemMedia>
              <ItemContent class="min-w-0">
                <button
                  type="button"
                  class="min-w-0 w-full text-left"
                  :aria-pressed="activeTeamId === team.id"
                  @click.stop="selectTeam(team.id)"
                >
                  <ItemTitle class="w-full">
                    <span
                      class="block truncate"
                      :title="team.name"
                      >{{ team.name }}</span
                    >
                  </ItemTitle>
                </button>
                <ItemDescription>{{ team.relation === 'main' ? '担任主 Agent' : '观察共享记录' }}</ItemDescription>
              </ItemContent>

              <Badge v-if="pendingInteractions[team.id]" variant="secondary" class="shrink-0" :aria-label="`${pendingInteractions[team.id]} 项待答复互动`">待答复 {{ pendingInteractions[team.id] }}</Badge>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon-xs" title="团队操作">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem @select="emit('openTeam', team.id)">
                      <ArrowUpRight />
                      打开团队
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      v-if="team.relation === 'observer'"
                      @select="emit('takeover', team)"
                    >
                      <ShieldCheck />
                      接管团队
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      v-else-if="team.controller.assignment?.original_lead_id"
                      @select="emit('handback', team)"
                    >
                      <ArrowUpRight class="rotate-180" />
                      交还原主 Agent
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </Item>
          </ItemGroup>
        </ScrollArea>
      </div>
</Disclosure>

      <div
        role="separator"
        aria-label="调整团队关系高度"
        aria-orientation="horizontal"
        :aria-valuenow="teamsShare"
        :aria-valuemin="15"
        :aria-valuemax="85"
        :aria-disabled="!canResize"
        :tabindex="canResize ? 0 : -1"
        class="flex h-3 shrink-0 touch-none items-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="canResize ? 'cursor-row-resize' : ''"
        @pointerdown="beginTeamsResize"
        @pointermove="moveTeamsResize"
        @pointerup="resizeStart = undefined"
        @pointercancel="resizeStart = undefined"
        @lostpointercapture="resizeStart = undefined"
        @keydown="resizeTeamsByKey"
      ><span class="h-px w-full bg-border" /></div>
      <Disclosure :heading-level="2" v-model:open="notificationsOpen" class="split-section" :style="{ flex: notificationsOpen ? `${teamsOpen ? 100 - teamsShare : 1} 1 0%` : '0 0 auto' }">
<template #summary><span ref="notificationsHeading" tabindex="-1" class="flex items-center gap-2"><Bell />团队来源通知</span><Badge variant="secondary">{{ notifications.length }}</Badge></template>

          <p v-if="!notifications.length" class="text-sm text-muted-foreground">暂无团队来源通知。</p>
          <div v-else class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <Card v-for="notification in notifications" :key="notification.id" size="compact"><CardContent class="flex min-w-0 flex-col gap-3 text-sm">
              <p class="whitespace-pre-wrap wrap-anywhere">{{ notification.text }}</p>
              <Button variant="outline" size="sm" @click="selectTeam(notification.group_id)">查看来源团队</Button>
            </CardContent></Card>
          </div>

</Disclosure>

    <Card v-if="unknown.length" class="shrink-0">
      <CardHeader><CardTitle>待核实运行</CardTitle></CardHeader>
      <CardContent>
        <p class="mt-2 text-xs leading-5 text-muted-foreground">
          相关团队写入已暂停。确认宿主进程停止后才能恢复。
        </p>
        <ItemGroup class="mt-3">
          <PanelConfirmationItem
            v-for="turn in unknown"
            :key="turn.turn_id"
            :icon="CircleAlert"
            title="宿主运行状态未知"
            :description="turn.turn_id"
          >
            <Button
              variant="outline"
              size="sm"
              @click="emit('resolveRuntime', turn.turn_id)"
            >
              已核实停止
            </Button>
          </PanelConfirmationItem>
        </ItemGroup>
      </CardContent>
    </Card>
    </div>
  </CollapsibleRightSidebar>
  </aside>
</template>

<style scoped>
.split-section { display: flex; flex-direction: column; min-height: 0; }
.split-section :deep([data-slot='disclosure-header']) { flex-shrink: 0; }
.split-section :deep(.collapse-reveal[data-open='true']) { flex: 1; min-height: 0; }
.split-section :deep(.collapse-reveal-clip) { display: flex; min-height: 0; }
.split-section :deep([data-slot='disclosure-content']) { flex: 1; min-height: 0; overflow: hidden; }
</style>
