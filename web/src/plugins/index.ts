import { NotebookPen, Search } from '@lucide/vue';
import NotesQuickInput from '@/features/notes/NotesQuickInput.vue';
import NotesWorkspace from '@/features/notes/NotesWorkspace.vue';
import { noteExcerpt, noteStateLabel } from '@/features/notes/notes-state';
import GlobalSearch from '@/features/productivity/GlobalSearch.vue';
import TelemetryCoordinationWorkspace from '@/features/telemetry/TelemetryCoordinationWorkspace.vue';
import { api } from '@/shared/api/client';
import {
  activeMounts as activeMountsIn,
  activePluginRoute as activePluginRouteIn,
  allPluginStaticEntries as allPluginStaticEntriesIn,
  collectPluginCommands as collectPluginCommandsIn,
  collectPluginOverlays as collectPluginOverlaysIn,
  collectPluginRoutes as collectPluginRoutesIn,
  collectSearchProviders as collectSearchProvidersIn,
  enabledPluginsOf as enabledPluginsOfIn,
  findPluginCommand,
  isMountVisible,
  matchHotkey,
  mountKey,
  navPluginEntries as navPluginEntriesIn,
  validatePluginRegistry,
} from './registry';
import type {
  PluginContext,
  PluginDefinition,
  PluginSlot,
  PluginUserState,
  SearchProvider,
} from './types';

export * from './types';
export {
  findPluginCommand,
  isMountVisible,
  matchHotkey,
  mountKey,
  validatePluginRegistry,
};

function deriveNoteHeadline(body: string): string {
  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return '无标题笔记';
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
}

const notesSearchProvider: SearchProvider = {
  id: 'notes',
  heading: '随心记',
  static: [
    {
      id: 'notes',
      label: '随心记',
      path: '/notes',
      keywords: '想法 记录 笔记 灵感 备忘 随手记 待办',
      pluginId: 'builtin.notes',
    },
  ],
  async query(term, signal) {
    const page = await api.notes({ state: 'all', q: term, limit: 8 }, signal);
    const seen = new Set<string>();
    const combined = [...page.pinned, ...page.notes].filter((note) => {
      if (seen.has(note.id)) return false;
      seen.add(note.id);
      return true;
    });
    return combined.slice(0, 8).map((note) => {
      const title = note.title.trim() || deriveNoteHeadline(note.body);
      const excerpt = noteExcerpt(note, 64);
      const sourceLabel = note.sourceTeamName ?? (note.sourceTeamId ? '团队已删除' : '');
      return {
        id: note.id,
        label: title,
        description: excerpt && excerpt !== title ? excerpt : undefined,
        meta: [noteStateLabel(note.state), sourceLabel].filter(Boolean).join(' · '),
        path: `/notes?note=${encodeURIComponent(note.id)}`,
      };
    });
  },
};

const coordinationPlugin: PluginDefinition = {
  id: 'builtin.coordination',
  name: '协调遥测',
  description: '主 Agent 协调会话总用量、成员消耗排行与执行详情。',
  scope: 'team',
  mounts: [
    {
      slot: 'team-tabs',
      component: TelemetryCoordinationWorkspace,
      provides: 'member-usage',
    },
  ],
};

const searchPlugin: PluginDefinition = {
  id: 'builtin.search',
  name: '全局搜索',
  description: '跨团队搜索页面、设置、成员、随心记与消息（⌘K / Ctrl+K）。',
  scope: 'global',
  icon: Search,
  overlays: [GlobalSearch],
  commands: [
    {
      id: 'open',
      title: '打开全局搜索',
      hotkey: { key: 'k', mod: true },
      run(ctx) {
        ctx.ui.searchOpen = !ctx.ui.searchOpen;
      },
      isActive(ctx) {
        return ctx.ui.searchOpen;
      },
    },
  ],
  mounts: [{ slot: 'left-nav', command: 'open' }],
};

const notesPlugin: PluginDefinition = {
  id: 'builtin.notes',
  name: '随心记',
  description: '私人随手记，可标注来源团队。',
  scope: 'global',
  icon: NotebookPen,
  routes: [{ name: 'notes', path: '/notes', component: NotesWorkspace }],
  mounts: [
    { slot: 'left-nav', route: 'notes' },
    { slot: 'right-tools', component: NotesQuickInput },
  ],
  searchProviders: [notesSearchProvider],
};

/** 内置插件随应用发布、不可卸载，仅控制启用/禁用与各槽位显隐。 */
export const BUILTIN_PLUGINS: readonly PluginDefinition[] = [
  coordinationPlugin,
  searchPlugin,
  notesPlugin,
];

validatePluginRegistry(BUILTIN_PLUGINS);

export function builtinPlugin(id: string): PluginDefinition | undefined {
  return BUILTIN_PLUGINS.find((plugin) => plugin.id === id);
}

export function enabledPluginsOf(prefs: PluginUserState) {
  return enabledPluginsOfIn(prefs, BUILTIN_PLUGINS);
}

export function activeMounts(slot: PluginSlot, prefs: PluginUserState) {
  return activeMountsIn(slot, prefs, BUILTIN_PLUGINS);
}

export function navPluginEntries(
  prefs: PluginUserState,
  currentRouteName?: string,
  ctx?: PluginContext,
) {
  return navPluginEntriesIn(prefs, currentRouteName, ctx, BUILTIN_PLUGINS);
}

export function collectPluginRoutes() {
  return collectPluginRoutesIn(BUILTIN_PLUGINS);
}

export function activePluginRoute(
  routeName: string | undefined,
  prefs: PluginUserState,
) {
  return activePluginRouteIn(routeName, prefs, BUILTIN_PLUGINS);
}

export function collectPluginOverlays(prefs: PluginUserState) {
  return collectPluginOverlaysIn(prefs, BUILTIN_PLUGINS);
}

export function collectPluginCommands(prefs: PluginUserState) {
  return collectPluginCommandsIn(prefs, BUILTIN_PLUGINS);
}

export function collectSearchProviders(prefs: PluginUserState) {
  return collectSearchProvidersIn(prefs, BUILTIN_PLUGINS);
}

export function allPluginStaticEntries() {
  return allPluginStaticEntriesIn(BUILTIN_PLUGINS);
}
