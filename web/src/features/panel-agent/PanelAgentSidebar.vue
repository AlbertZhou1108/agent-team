<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  ArrowUpRight,
  Check,
  ChevronsUpDown,
  CircleAlert,
  FileClock,
  MoreHorizontal,
  ShieldCheck,
  Users,
  X,
} from '@lucide/vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';
import PanelConfirmationItem from './PanelConfirmationItem.vue';
import { isPreparationApprovable } from './preparation';
import type {
  PanelAction,
  PanelPreparation,
  PanelTeam,
  PanelUnknownTurn,
} from './types';

const props = defineProps<{
  teams: PanelTeam[];
  pendingActions: PanelAction[];
  pendingPreparations: PanelPreparation[];
  unknown: PanelUnknownTurn[];
}>();
const teamsOpen = ref(props.teams.length > 0);
watch(
  () => props.teams.length,
  count => {
    teamsOpen.value = count > 0;
  },
);
const activeTeamId = defineModel<string>({ required: true });
const emit = defineEmits<{
  openTeam: [teamId: string];
  takeover: [team: PanelTeam];
  handback: [team: PanelTeam];
  decideAction: [id: string, approved: boolean];
  approvePreparation: [preparation: PanelPreparation];
  resolveRuntime: [turnId: string];
}>();

function selectTeam(teamId: string) {
  activeTeamId.value = teamId;
}

function onTeamCardClick(teamId: string, event: MouseEvent) {
  if ((event.target as HTMLElement).closest('button')) return;
  selectTeam(teamId);
}
</script>

<template>
  <aside class="agent-side">
    <section v-if="pendingActions.length" class="panel agent-side-card">
      <h2 class="text-sm font-semibold">操作确认</h2>
      <ItemGroup class="mt-3 gap-2">
        <PanelConfirmationItem
          v-for="action in pendingActions"
          :key="action.id"
          :icon="ShieldCheck"
          :title="`${action.action === 'takeover' ? '接管' : '交还'}${teams.find(team => team.id === action.group_id)?.name ?? action.group_id}`"
          :description="`控制者 revision ${action.base_revision}`"
        >
          <template #meta>
            <Badge variant="warning" class="mt-1 w-fit">待确认</Badge>
          </template>
          <Button size="sm" @click="emit('decideAction', action.id, true)">
            <Check data-icon="inline-start" />
            确认
          </Button>
          <Button
            size="sm"
            variant="ghost"
            @click="emit('decideAction', action.id, false)"
          >
            <X data-icon="inline-start" />
            取消
          </Button>
        </PanelConfirmationItem>
      </ItemGroup>
    </section>

    <Collapsible v-model:open="teamsOpen" class="panel agent-side-card flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <h2 class="text-sm font-semibold">团队关系</h2>
          <Badge>{{ teams.length }}</Badge>
        </div>
        <CollapsibleTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="size-8"
          >
            <ChevronsUpDown />
            <span class="sr-only">{{ teamsOpen ? '收起团队关系' : '展开团队关系' }}</span>
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <p class="px-1 pb-2 text-[11px] leading-4 text-muted-foreground">
          选中团队即切换上下文；选择“全部团队”返回全局。
        </p>
        <ScrollArea
          class="w-full pr-2"
          item-selector="[data-team-relation-item]"
          :max-visible-items="10"
          aria-label="团队关系列表"
        >
          <ItemGroup class="gap-1">
            <Item
              :variant="activeTeamId ? 'default' : 'muted'"
              size="sm"
              class="cursor-pointer flex-nowrap px-2 py-2"
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
                  <ItemTitle class="w-full leading-snug">全部团队</ItemTitle>
                </button>
              </ItemContent>
              <Badge
                :variant="activeTeamId ? 'default' : 'success'"
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
              class="cursor-pointer flex-nowrap px-2 py-2"
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
                  <ItemTitle class="w-full leading-snug">
                    <span class="block whitespace-normal [overflow-wrap:anywhere]">{{ team.name }}</span>
                  </ItemTitle>
                </button>
              </ItemContent>
              <Badge
                :variant="team.relation === 'main' ? 'success' : 'default'"
                class="shrink-0 whitespace-nowrap"
              >
                {{ team.relation === 'main' ? '主 Agent' : '观察' }}
              </Badge>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="团队操作"
                  >
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

    <section v-if="pendingPreparations.length" class="panel agent-side-card">
      <h2 class="text-sm font-semibold">等待确认</h2>
      <ItemGroup class="mt-3 gap-2">
        <PanelConfirmationItem
          v-for="preparation in pendingPreparations"
          :key="preparation.id"
          :icon="FileClock"
          :title="preparation.spec.name"
          :description="preparation.contract?.goal"
          actions-at-footer
        >
          <template #meta>
            <div class="flex flex-wrap items-center gap-2">
              <Badge variant="warning">revision {{ preparation.revision }}</Badge>
              <span class="text-[10px] text-muted-foreground">
                {{ preparation.spec.members.length }} 名普通角色 ·
                {{ preparation.rolePlan?.roles.length ?? 0 }} 个模型计划
              </span>
            </div>
          </template>
          <Button
            size="sm"
            :disabled="!isPreparationApprovable(preparation)"
            @click="emit('approvePreparation', preparation)"
          >
            <Check data-icon="inline-start" />
            批准
          </Button>
        </PanelConfirmationItem>
      </ItemGroup>
    </section>

    <section v-if="unknown.length" class="panel agent-side-card">
      <h2 class="text-sm font-semibold">待核实运行</h2>
      <p class="mt-2 text-xs leading-5 text-muted-foreground">
        相关团队写入已暂停。确认宿主进程停止后才能恢复。
      </p>
      <ItemGroup class="mt-3 gap-2">
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
    </section>
  </aside>
</template>
