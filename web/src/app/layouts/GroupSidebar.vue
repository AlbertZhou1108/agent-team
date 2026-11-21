<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { computed, ref } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { Bot, House, Settings2, Users } from '@lucide/vue';
import { Surface } from '@/components/surface';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Group, Member } from '@/shared/api/raw-types';
import { NOTE_DRAG_TYPE, noteIdsFrom } from '@/shared/pdd-drag';
import { usePddBindings } from '@/shared/use-pdd-bindings';
import { useSortable } from '@/shared/use-sortable';
import { withGap } from '@/shared/sort-preview';
import { useNoteHandoffStore } from '@/stores/note-handoff';
import { usePreferencesStore, type PrimaryNavId } from '@/stores/preferences';
import { mountKey } from '@/tools';
import { cn } from '@/lib/utils';
import SidebarEntry from './SidebarEntry.vue';
import TeamSecondaryPanel from './TeamSecondaryPanel.vue';

export interface SidebarToolEntry {
  id: string;
  label: string;
  icon?: unknown;
  current: boolean;
}

const props = withDefaults(
  defineProps<{
    groups: Group[];
    members?: Member[];
    currentGroupId?: string;
    homeActive: boolean;
    /** 工具模块的左导航条目(left-nav 挂载),位于一级栏插件区。 */
    toolEntries: SidebarToolEntry[];
    agentActive: boolean;
    agentUnreadCount: number;
    settingsActive: boolean;
    /** 可选受控开关：团队二级面板是否显示；不传时由组件内部维护，默认打开。 */
    secondaryOpen?: boolean;
    groupUnreadByTeam?: ReadonlyMap<string, number>;
    activityByTeam?: ReadonlyMap<string, number>;
  }>(),
  {
    members: () => [],
    secondaryOpen: undefined,
  },
);

const emit = defineEmits<{
  select: [id: string];
  createTeam: [];
  archive: [ids: string[]];
  activateTool: [id: string];
  openAgent: [];
  openSettings: [];
  'update:secondaryOpen': [open: boolean];
}>();

const preferences = usePreferencesStore();
// 窄屏把一级栏压成顶部横向图标条:不渲染二级面板，团队列表交给主页。
const compact = useMediaQuery('(max-width: 760px)');
const tooltipSide = computed<'bottom' | 'right'>(() => (compact.value ? 'bottom' : 'right'));

const internalSecondaryOpen = ref(
  !props.homeActive
    && !props.agentActive
    && !props.settingsActive
    && !props.toolEntries.some(entry => entry.current),
);

const isSecondaryOpen = computed(() =>
  props.secondaryOpen !== undefined ? props.secondaryOpen : internalSecondaryOpen.value,
);

const showSecondary = computed(() => isSecondaryOpen.value && !compact.value);

function setSecondaryOpen(open: boolean) {
  internalSecondaryOpen.value = open;
  emit('update:secondaryOpen', open);
}

const agentUnreadLabel = computed(() =>
  props.agentUnreadCount > 99 ? '99+' : String(props.agentUnreadCount),
);

/* 笔记拖到 Panel Agent:投放目标注册给 PDD,按负载类型分流(canDrop)。 */
const noteHandoff = useNoteHandoffStore();
const noteDragOver = ref(false);
const notePddBindings = usePddBindings();

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

const noteDropTargetRef = stableRef('note-handoff', (element, previous) => {
  notePddBindings.bind('note-handoff', element, el => dropTargetForElements({
    element: el,
    canDrop: ({ source }) => source.data.type === NOTE_DRAG_TYPE,
    getData: () => ({ type: 'note-handoff-target', tone: 'primary' }),
    getDropEffect: () => 'move',
    onDragEnter: () => { noteDragOver.value = true; },
    onDragLeave: () => { noteDragOver.value = false; },
    onDrop: ({ source }) => {
      noteDragOver.value = false;
      noteHandoff.request(noteIdsFrom(source));
    },
  }), previous);
});

// 固定区一级图标：按 preferences.primaryNavOrder 排序，支持区内 PDD 拖拽重排。
const fixedZoneEl = ref<HTMLElement | null>(null);
const fixedItems = computed(() =>
  preferences.primaryNavOrder.map((id) => {
    if (id === 'home') {
      return { id, label: '主页' };
    }
    if (id === 'team') {
      return { id, label: '团队' };
    }
    return { id, label: 'Panel Agent' };
  }),
);

function reorderFixed(id: string, targetId: string, after: boolean) {
  if (id === targetId) return;
  const current = [...preferences.primaryNavOrder].filter(item => item !== id) as PrimaryNavId[];
  const index = current.indexOf(targetId as PrimaryNavId);
  if (index < 0) return;
  current.splice(index + (after ? 1 : 0), 0, id as PrimaryNavId);
  preferences.setPrimaryNavOrder(current);
}

const fixedSortable = useSortable({
  root: fixedZoneEl,
  scope: 'primary-fixed',
  ids: () => fixedItems.value.map(item => item.id),
  canDrag: () => true,
  canTarget: () => true,
  axis: () => (compact.value ? 'x' : 'y'),
  onReorder: reorderFixed,
});

const fixedSortItems = computed(() =>
  withGap(fixedItems.value, fixedSortable.preview.value, fixedSortable.draggingIds.value),
);

function fixedItemRef(id: PrimaryNavId) {
  return stableRef(`fixed:${id}`, (el, prev) => {
    fixedSortable.bindItem(id, el, prev);
  });
}

const fixedGapRef = stableRef('fixed-gap', (el, prev) => fixedSortable.bindGap(el, prev));

// 插件区一级图标：由工具注册表派生，支持区内 PDD 拖拽重排并持久化到 left-nav 顺序。
const pluginZoneEl = ref<HTMLElement | null>(null);

function reorderPlugin(id: string, targetId: string, after: boolean) {
  if (id === targetId) return;
  const order = props.toolEntries
    .map(entry => mountKey(entry.id, 'left-nav'))
    .filter(key => key !== id);
  const index = order.indexOf(targetId);
  if (index < 0) return;
  order.splice(index + (after ? 1 : 0), 0, id);
  preferences.setToolOrder('left-nav', order);
}

const pluginSortable = useSortable({
  root: pluginZoneEl,
  scope: 'primary-plugin',
  ids: () => props.toolEntries.map(entry => mountKey(entry.id, 'left-nav')),
  canDrag: () => true,
  canTarget: () => true,
  axis: () => (compact.value ? 'x' : 'y'),
  onReorder: reorderPlugin,
});

const pluginSortItems = computed(() =>
  withGap(
    props.toolEntries.map(entry => ({ ...entry, keyId: mountKey(entry.id, 'left-nav') })),
    pluginSortable.preview.value,
    pluginSortable.draggingIds.value,
  ),
);

function pluginItemRef(keyId: string) {
  return stableRef(`plugin:${keyId}`, (el, prev) => pluginSortable.bindItem(keyId, el, prev));
}

const pluginGapRef = stableRef('plugin-gap', (el, prev) => pluginSortable.bindGap(el, prev));

function activateHome() {
  setSecondaryOpen(false);
  emit('select', '');
}

function activateTeam() {
  setSecondaryOpen(true);
}

function activateAgent() {
  setSecondaryOpen(false);
  emit('openAgent');
}

function activatePlugin(toolId: string) {
  setSecondaryOpen(false);
  emit('activateTool', toolId);
}

function activateSettings() {
  setSecondaryOpen(false);
  emit('openSettings');
}

function fixedAriaLabel(id: PrimaryNavId): string {
  if (id === 'home') return '主页';
  if (id === 'team') return '团队';
  return props.agentUnreadCount ? `Panel Agent，${props.agentUnreadCount} 条新消息` : 'Panel Agent';
}

function fixedTooltipLabel(id: PrimaryNavId): string {
  if (id === 'home') return '主页';
  if (id === 'team') return '团队';
  return 'Panel Agent';
}

function fixedTitle(id: PrimaryNavId): string {
  if (id === 'home') return '主页';
  if (id === 'team') return '团队';
  return props.agentUnreadCount ? `Panel Agent（${props.agentUnreadCount} 条新消息）` : 'Panel Agent';
}
</script>

<template>
  <TooltipProvider :delay-duration="250">
    <Surface
      role="nav-panel"
      as="aside"
      :class="cn('group-sidebar', showSecondary && 'group-sidebar-with-secondary')"
    >
      <!-- 最左一级图标栏：固定 64px、无 Logo、只图标 + Tooltip、分固定区与插件区、无收起按钮 -->
      <div class="primary-rail" data-testid="primary-rail">
        <nav aria-label="一级导航" class="primary-nav">
          <!-- 固定区：主页 / 团队 / Panel Agent -->
          <div ref="fixedZoneEl" class="primary-nav-zone" data-nav-zone="fixed">
            <template v-for="slot in fixedSortItems" :key="slot.key">
              <div
                v-if="slot.item"
                :ref="fixedItemRef(slot.item.id)"
                class="primary-nav-item"
                :data-primary-id="slot.item.id"
                :data-sort-hidden="slot.hidden ? 'true' : undefined"
                :data-flip-key="slot.hidden ? undefined : `primary-fixed:${slot.item.id}`"
                :data-note-drop-target="
                  slot.item.id === 'agent'
                    ? (noteDragOver ? 'hot' : noteHandoff.dragActive ? 'ready' : undefined)
                    : undefined
                "
              >
                <Tooltip>
                  <TooltipTrigger as-child>
                    <div
                      :ref="slot.item.id === 'agent' ? noteDropTargetRef : undefined"
                      class="flex justify-center"
                    >
                      <SidebarEntry
                        v-if="slot.item.id === 'home'"
                        collapsed
                        :current="!showSecondary && homeActive"
                        :label="fixedAriaLabel('home')"
                        :title="fixedTitle('home')"
                        @activate="activateHome"
                      >
                        <template #icon><House /></template>
                        主页
                      </SidebarEntry>
                      <SidebarEntry
                        v-else-if="slot.item.id === 'team'"
                        collapsed
                        :current="showSecondary"
                        :pressed="showSecondary"
                        :expanded="showSecondary"
                        :controls="showSecondary ? 'team-secondary-panel' : undefined"
                        :label="fixedAriaLabel('team')"
                        :title="fixedTitle('team')"
                        @activate="activateTeam"
                      >
                        <template #icon><Users /></template>
                        团队
                      </SidebarEntry>
                      <SidebarEntry
                        v-else
                        collapsed
                        :current="!showSecondary && agentActive"
                        :label="fixedAriaLabel('agent')"
                        :title="fixedTitle('agent')"
                        @activate="activateAgent"
                      >
                        <template #icon><Bot /></template>
                        Panel Agent
                        <template v-if="agentUnreadCount" #indicator>
                          <Badge variant="default" class="sidebar-unread-count" aria-hidden="true">
                            {{ agentUnreadLabel }}
                          </Badge>
                        </template>
                      </SidebarEntry>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent :side="tooltipSide">{{ fixedTooltipLabel(slot.item.id) }}</TooltipContent>
                </Tooltip>
              </div>
              <div
                v-else
                :ref="fixedGapRef"
                class="primary-sort-gap"
                aria-hidden="true"
                :style="{ height: compact ? undefined : `${fixedSortable.preview.value?.height ?? 0}px` }"
              />
            </template>
          </div>

          <Separator
            v-if="toolEntries.length"
            :orientation="compact ? 'vertical' : 'horizontal'"
            class="primary-nav-separator"
            aria-hidden="true"
          />

          <!-- 插件区：全局搜索 / 随心记等 left-nav 工具挂载 -->
          <div v-if="toolEntries.length" ref="pluginZoneEl" class="primary-nav-zone" data-nav-zone="plugin">
            <template v-for="slot in pluginSortItems" :key="slot.key">
              <div
                v-if="slot.item"
                :ref="pluginItemRef(slot.item.keyId)"
                class="primary-nav-item"
                :data-tool-id="slot.item.id"
                :data-sort-hidden="slot.hidden ? 'true' : undefined"
                :data-flip-key="slot.hidden ? undefined : `primary-plugin:${slot.item.keyId}`"
              >
                <Tooltip>
                  <TooltipTrigger as-child>
                    <div class="flex justify-center">
                      <SidebarEntry
                        collapsed
                        :current="!showSecondary && slot.item.current"
                        :label="slot.item.label"
                        :title="slot.item.label"
                        @activate="activatePlugin(slot.item.id)"
                      >
                        <template #icon><component :is="slot.item.icon" v-if="slot.item.icon" /></template>
                        {{ slot.item.label }}
                      </SidebarEntry>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent :side="tooltipSide">{{ slot.item.label }}</TooltipContent>
                </Tooltip>
              </div>
              <div
                v-else
                :ref="pluginGapRef"
                class="primary-sort-gap"
                aria-hidden="true"
                :style="{ height: compact ? undefined : `${pluginSortable.preview.value?.height ?? 0}px` }"
              />
            </template>
          </div>
        </nav>

        <!-- 底部仅留设置入口；无连接状态 UI、无收起/展开按钮 -->
        <div class="sidebar-actions">
          <Tooltip>
            <TooltipTrigger as-child>
              <div class="flex justify-center">
                <SidebarEntry
                  collapsed
                  :current="!showSecondary && settingsActive"
                  label="设置"
                  title="设置"
                  @activate="activateSettings"
                >
                  <template #icon><Settings2 /></template>
                  设置
                </SidebarEntry>
              </div>
            </TooltipTrigger>
            <TooltipContent :side="tooltipSide">设置</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <!-- 二级面板：仅团队项选中且宽屏时常驻显示 -->
      <TeamSecondaryPanel
        v-if="showSecondary"
        id="team-secondary-panel"
        :groups="groups"
        :members="members"
        :current-group-id="currentGroupId"
        :group-unread-by-team="groupUnreadByTeam"
        :activity-by-team="activityByTeam"
        @select="emit('select', $event)"
        @create-team="emit('createTeam')"
        @archive="emit('archive', $event)"
      />
    </Surface>
  </TooltipProvider>
</template>
