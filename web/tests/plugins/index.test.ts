import { defineComponent } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_PLUGINS,
  PLUGIN_SLOTS,
  activeMounts,
  activePluginRoute,
  builtinPlugin,
  collectPluginCommands,
  collectPluginOverlays,
  collectPluginRoutes,
  collectSearchProviders,
  enabledPluginsOf,
  isMountVisible,
  matchHotkey,
  navPluginEntries,
  validatePluginRegistry,
  type PluginContext,
  type PluginDefinition,
} from '@/plugins';
import {
  activeMounts as activeMountsIn,
  activePluginRoute as activePluginRouteIn,
  collectPluginCommands as collectPluginCommandsIn,
  collectPluginRoutes as collectPluginRoutesIn,
  collectSearchProviders as collectSearchProvidersIn,
} from '@/plugins/registry';

describe('内置插件注册表 v3', () => {
  it('每个插件都满足契约 v3 不变式', () => {
    expect(() => validatePluginRegistry(BUILTIN_PLUGINS)).not.toThrow();
    for (const plugin of BUILTIN_PLUGINS) {
      expect(plugin.id).toMatch(/^builtin\./);
      expect(plugin.name.length).toBeGreaterThan(0);
      expect(plugin.mounts.length).toBeGreaterThan(0);
      for (const mount of plugin.mounts) expect(PLUGIN_SLOTS).toContain(mount.slot);
    }
  });

  it('首批插件的挂载位置与贡献点符合设计意图', () => {
    const coordination = builtinPlugin('builtin.coordination')!;
    expect(coordination.scope).toBe('team');
    expect(coordination.mounts.map((mount) => mount.slot)).toEqual(['team-tabs']);
    expect(coordination.mounts[0]?.slot).toBe('team-tabs');

    const search = builtinPlugin('builtin.search')!;
    expect(search.scope).toBe('global');
    expect(search.mounts.map((mount) => mount.slot)).toEqual(['left-nav']);
    expect(search.overlays).toHaveLength(1);
    expect(search.commands?.[0]?.hotkey).toEqual({ key: 'k', mod: true });

    const notes = builtinPlugin('builtin.notes')!;
    expect(notes.scope).toBe('global');
    expect(notes.mounts.map((mount) => mount.slot)).toEqual(['left-nav', 'right-tools']);
    expect(notes.routes?.map((route) => route.name)).toEqual(['notes']);
    expect(notes.searchProviders).toHaveLength(1);
  });
});

describe('validatePluginRegistry 不变式校验', () => {
  const Dummy = defineComponent({ render: () => null });

  it('拒绝重复插件 id、重复槽位、非 global 的 left-nav、缺失引用与冲突路由', () => {
    const valid: PluginDefinition = {
      id: 'ext.sample',
      name: '示例',
      scope: 'global',
      routes: [{ name: 'sample', path: '/sample', component: Dummy }],
      commands: [{ id: 'ping', title: 'Ping', run: () => {} }],
      mounts: [{ slot: 'left-nav', route: 'sample' }],
    };
    expect(() => validatePluginRegistry([valid])).not.toThrow();
    expect(() => validatePluginRegistry([valid, valid])).toThrow(/重复/);

    expect(() =>
      validatePluginRegistry([
        {
          id: 'ext.dup-slot',
          name: '重复槽位',
          scope: 'team',
          mounts: [
            { slot: 'team-tabs', component: Dummy },
            { slot: 'team-tabs', component: Dummy },
          ],
        },
      ]),
    ).toThrow(/重复声明/);

    expect(() =>
      validatePluginRegistry([
        {
          id: 'ext.bad-scope',
          name: '坏作用域',
          scope: 'team',
          commands: [{ id: 'open', title: 'Open', run: () => {} }],
          mounts: [{ slot: 'left-nav', command: 'open' }],
        },
      ]),
    ).toThrow(/global/);

    expect(() =>
      validatePluginRegistry([
        {
          id: 'ext.bad-ref',
          name: '坏引用',
          scope: 'global',
          mounts: [{ slot: 'left-nav', route: 'missing' }],
        },
      ]),
    ).toThrow(/路由不存在/);

    expect(() =>
      validatePluginRegistry([
        {
          id: 'ext.conflict-route',
          name: '冲突路由',
          scope: 'global',
          routes: [{ name: 'notes-dup', path: '/settings', component: Dummy }],
          mounts: [{ slot: 'left-nav', route: 'notes-dup' }],
        },
      ]),
    ).toThrow(/冲突/);
  });

  it('假插件无需改宿主即可独立贡献路由、命令、team-tabs 与搜索条目', () => {
    const fake: PluginDefinition = {
      id: 'ext.fake',
      name: '假插件',
      scope: 'global',
      routes: [{ name: 'fake-page', path: '/fake', component: Dummy }],
      commands: [{ id: 'go', title: 'Go', hotkey: { key: 'j', mod: true }, run: () => {} }],
      mounts: [
        { slot: 'left-nav', command: 'go' },
        { slot: 'team-tabs', component: Dummy, label: '假标签' },
      ],
      searchProviders: [{ id: 'fake', heading: '假插件', static: [{ id: 'fake-item', label: '假条目', path: '/fake' }] }],
    };
    expect(() => validatePluginRegistry([fake])).not.toThrow();
    expect(collectPluginRoutesIn([fake])).toHaveLength(1);
    expect(collectPluginCommandsIn({ disabled: { 'ext.fake': true } }, [fake])).toHaveLength(0);
    expect(collectPluginCommandsIn({}, [fake])).toHaveLength(1);
    expect(activeMountsIn('team-tabs', {}, [fake])).toHaveLength(1);
    expect(activePluginRouteIn('fake-page', {}, [fake])?.enabled).toBe(true);
    expect(collectSearchProvidersIn({}, [fake])[0]?.pluginId).toBe('ext.fake');
    expect(collectSearchProvidersIn({ disabled: { 'ext.fake': true } }, [fake])).toEqual([]);
  });
});

describe('enabledPluginsOf / isMountVisible / activeMounts', () => {
  const byId = (plugins: PluginDefinition[]) => plugins.map((plugin) => plugin.id);

  it('按 disabled 过滤整组插件，未记录或未知 id 不影响其余插件', () => {
    expect(byId(enabledPluginsOf({}))).toHaveLength(BUILTIN_PLUGINS.length);
    expect(byId(enabledPluginsOf({ disabled: { 'builtin.notes': true } }))).not.toContain('builtin.notes');
    expect(byId(enabledPluginsOf({ disabled: { 'builtin.ghost': true } }))).toHaveLength(BUILTIN_PLUGINS.length);
  });

  it('isMountVisible 同时受插件禁用与单挂载隐藏控制', () => {
    const notes = builtinPlugin('builtin.notes')!;
    const quickInput = notes.mounts.find((mount) => mount.slot === 'right-tools')!;
    const nav = notes.mounts.find((mount) => mount.slot === 'left-nav')!;
    expect(isMountVisible(notes, quickInput, { disabled: { 'builtin.notes': true } })).toBe(false);
    const prefs = { hidden: { 'builtin.notes:right-tools': true } };
    expect(isMountVisible(notes, quickInput, prefs)).toBe(false);
    expect(isMountVisible(notes, nav, prefs)).toBe(true);
  });

  it('right-tools 仅保留随心记快记；team-tabs 挂载协调遥测并支持禁用与隐藏', () => {
    expect(activeMounts('right-tools', {}).map((entry) => entry.plugin.id)).toEqual(['builtin.notes']);
    expect(activeMounts('team-tabs', {}).map((entry) => entry.plugin.id)).toEqual(['builtin.coordination']);
    expect(activeMounts('team-tabs', { hidden: { 'builtin.coordination:team-tabs': true } })).toEqual([]);
    expect(activeMounts('team-tabs', { disabled: { 'builtin.coordination': true } })).toEqual([]);
  });
});

describe('navPluginEntries / 贡献点收集 / 热键匹配', () => {
  it('left-nav 生成导航条目并由 command.isActive 驱动激活态', () => {
    const ctx = { router: {} as PluginContext['router'], ui: { searchOpen: true } as PluginContext['ui'] };
    const entries = navPluginEntries({}, 'notes', ctx);
    expect(entries).toEqual([
      { id: 'builtin.search', command: 'open', label: '全局搜索', icon: expect.anything(), current: true },
      { id: 'builtin.notes', route: 'notes', label: '随心记', icon: expect.anything(), current: true },
    ]);
    expect(navPluginEntries({}, undefined, undefined)[0]?.current).toBe(false);
  });

  it('遵循 left-nav 槽位排序', () => {
    const entries = navPluginEntries({
      order: { 'left-nav': ['builtin.notes:left-nav', 'builtin.search:left-nav'] },
    });
    expect(entries.map((entry) => entry.id)).toEqual(['builtin.notes', 'builtin.search']);
  });

  it('禁用全局搜索后浮层与命令均被摘除', () => {
    expect(collectPluginOverlays({}).map((item) => item.pluginId)).toEqual(['builtin.search']);
    expect(collectPluginOverlays({ disabled: { 'builtin.search': true } })).toEqual([]);
    expect(collectPluginCommands({ disabled: { 'builtin.search': true } })).toEqual([]);
  });

  it('禁用随心记后路由状态标为 disabled，搜索 provider 被摘除', () => {
    expect(collectPluginRoutes().map((item) => item.route.name)).toEqual(['notes']);
    expect(activePluginRoute('notes', {})?.enabled).toBe(true);
    expect(activePluginRoute('notes', { disabled: { 'builtin.notes': true } })?.enabled).toBe(false);
    expect(collectSearchProviders({}).map((provider) => provider.id)).toEqual(['notes']);
    expect(collectSearchProviders({ disabled: { 'builtin.notes': true } })).toEqual([]);
  });

  it('matchHotkey 匹配 Meta/Ctrl + key', () => {
    const hotkey = { key: 'k', mod: true } as const;
    expect(matchHotkey({ key: 'k', metaKey: true, ctrlKey: false, altKey: false } as KeyboardEvent, hotkey)).toBe(true);
    expect(matchHotkey({ key: 'K', metaKey: false, ctrlKey: true, altKey: false } as KeyboardEvent, hotkey)).toBe(true);
    expect(matchHotkey({ key: 'k', metaKey: false, ctrlKey: false, altKey: false } as KeyboardEvent, hotkey)).toBe(false);
    expect(matchHotkey({ key: 'k', metaKey: true, ctrlKey: false, altKey: true } as KeyboardEvent, hotkey)).toBe(false);
  });

  it('search open 命令可切换 ui.searchOpen', () => {
    const ui = { searchOpen: false } as PluginContext['ui'];
    const [{ command }] = collectPluginCommands({});
    command.run({ router: { push: vi.fn() } as unknown as PluginContext['router'], ui });
    expect(ui.searchOpen).toBe(true);
  });
});
