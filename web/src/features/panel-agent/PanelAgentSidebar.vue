<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { usePanelAgentStore } from '@/stores/panel-agent';
import type { PanelMessage, TeamRequest, PanelAgentState } from '@/shared/api/raw-types';
import {
  ArrowUpRight,
  ChevronsUpDown,
  CheckCheck,
  CircleAlert,
  MoreHorizontal,
  ShieldCheck,
  Users,
} from '@lucide/vue';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
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
const unread = (teamId: string) => panelState.unreadForContext(props.messages, teamId);
const hasUnread = computed(() => unread('') > 0 || panelState.unreadReceipts(props.requests) > 0);
const teamsOpen = ref(props.teams.length > 0);
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
  <aside class="agent-side">
    <Collapsible
      v-model:open="teamsOpen"
      class="panel agent-side-card flex flex-col gap-4"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <h2 class="text-sm font-semibold">团队关系</h2>
          <Badge>{{ teams.length }}</Badge>
        </div>
        <div class="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="inline-flex" :tabindex="hasUnread ? undefined : 0" :aria-label="hasUnread ? undefined : '全部已读，当前没有未读消息'">
                <Button variant="ghost" size="icon" :disabled="!hasUnread" aria-label="全部已读" @click="panelState.markAllPanelRead(messages.filter(message => message.active_team_id == null)); panelState.syncReceiptReads(requests, true)">
                  <CheckCheck />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>将全局私人会话和请求回执标为已读</TooltipContent>
          </Tooltip>
        <CollapsibleTrigger as-child>
          <Button variant="ghost" size="icon">
            <ChevronsUpDown />
            <span class="sr-only">{{
              teamsOpen ? '收起团队关系' : '展开团队关系'
            }}</span>
          </Button>
        </CollapsibleTrigger>
        </div>
      </div>
      <CollapsibleContent class="flex min-h-0 flex-col gap-4">
        <p class="px-1 text-sm text-muted-foreground leading-5">
          点击团队进入团队协作会话，与该团队主 Agent 继续沟通。
        </p>
        <ScrollArea
          class="w-full"
          item-selector="[data-team-relation-item]"
          :max-visible-items="10"
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
      </CollapsibleContent>
    </Collapsible>

    <details v-if="notifications.length" class="flex min-w-0 flex-col gap-3">
      <summary class="cursor-pointer text-sm font-medium">团队来源通知（{{ notifications.length }}）</summary>
      <div class="mt-3 flex max-h-64 flex-col gap-3 overflow-y-auto">
        <div v-for="notification in notifications" :key="notification.id" class="flex flex-col gap-2 rounded-lg border p-3 text-sm">
          <p class="whitespace-pre-wrap">{{ notification.text }}</p>
          <Button variant="outline" size="sm" @click="selectTeam(notification.group_id)">查看来源团队</Button>
        </div>
      </div>
    </details>

    <Card v-if="unknown.length" class="panel agent-side-card">
      <CardContent>
        <h2 class="text-sm font-semibold">待核实运行</h2>
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
  </aside>
</template>
