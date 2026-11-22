import {
  CORE_ROUTE_NAMES,
  CORE_ROUTE_PATHS,
  PLUGIN_SLOTS,
  type MountedPlugin,
  type PluginCommand,
  type PluginContext,
  type PluginDefinition,
  type PluginHotkey,
  type PluginMount,
  type PluginNavEntry,
  type PluginSlot,
  type PluginUserState,
  type RegisteredPluginCommand,
  type RegisteredPluginOverlay,
  type ResolvedPluginRoute,
  type SearchProvider,
} from './types';

export const mountKey = (pluginId: string, slot: PluginSlot) =>
  `${pluginId}:${slot}`;

/** 校验插件注册表不变式：违例直接抛出异常。 */
export function validatePluginRegistry(
  plugins: readonly PluginDefinition[],
): void {
  const seenPluginIds = new Set<string>();
  const seenRouteNames = new Set<string>(CORE_ROUTE_NAMES);
  const seenRoutePaths = new Set<string>(CORE_ROUTE_PATHS);

  for (const plugin of plugins) {
    if (!plugin.id || seenPluginIds.has(plugin.id)) {
      throw new Error(`插件 id 重复或为空：${plugin.id}`);
    }
    seenPluginIds.add(plugin.id);

    if (!plugin.mounts.length) {
      throw new Error(`插件「${plugin.id}」至少需声明一个 mount`);
    }

    const commandIds = new Set<string>();
    for (const command of plugin.commands ?? []) {
      if (!command.id || commandIds.has(command.id)) {
        throw new Error(`插件「${plugin.id}」命令 id 重复或为空：${command.id}`);
      }
      commandIds.add(command.id);
    }

    const routeNames = new Set<string>();
    for (const route of plugin.routes ?? []) {
      if (!route.path.startsWith('/')) {
        throw new Error(`插件「${plugin.id}」路由路径必须以 / 开头：${route.path}`);
      }
      if (seenRouteNames.has(route.name)) {
        throw new Error(`插件「${plugin.id}」路由名与核心或其它插件冲突：${route.name}`);
      }
      if (seenRoutePaths.has(route.path)) {
        throw new Error(`插件「${plugin.id}」路由路径与核心或其它插件冲突：${route.path}`);
      }
      seenRouteNames.add(route.name);
      seenRoutePaths.add(route.path);
      routeNames.add(route.name);
    }

    const slots = new Set<PluginSlot>();
    for (const mount of plugin.mounts) {
      if (!(PLUGIN_SLOTS as readonly string[]).includes(mount.slot)) {
        throw new Error(`插件「${plugin.id}」声明了未知槽位：${String(mount.slot)}`);
      }
      if (slots.has(mount.slot)) {
        throw new Error(`插件「${plugin.id}」在同一槽位重复声明：${mount.slot}`);
      }
      slots.add(mount.slot);

      if (mount.slot === 'left-nav') {
        if (plugin.scope !== 'global') {
          throw new Error(`插件「${plugin.id}」挂载到 left-nav 时 scope 必须为 global`);
        }
        if ('route' in mount) {
          if (!routeNames.has(mount.route)) {
            throw new Error(`插件「${plugin.id}」left-nav 引用的路由不存在：${mount.route}`);
          }
        } else if (!commandIds.has(mount.command)) {
          throw new Error(`插件「${plugin.id}」left-nav 引用的命令不存在：${mount.command}`);
        }
      }
    }
  }
}

/** 挂载是否显示：插件未禁用且该挂载未被单独隐藏。 */
export function isMountVisible(
  plugin: PluginDefinition,
  mount: PluginMount,
  prefs: PluginUserState,
): boolean {
  return !prefs.disabled?.[plugin.id] && !prefs.hidden?.[mountKey(plugin.id, mount.slot)];
}

/** 未被禁用的插件列表。 */
export function enabledPluginsOf(
  prefs: PluginUserState,
  plugins: readonly PluginDefinition[],
): PluginDefinition[] {
  return plugins.filter((plugin) => !prefs.disabled?.[plugin.id]);
}

/** 某个槽位当前应显示的挂载（先置顶，再用户 order，最后落回注册顺序）。 */
export function activeMounts(
  slot: PluginSlot,
  prefs: PluginUserState,
  plugins: readonly PluginDefinition[],
): MountedPlugin[] {
  const order = prefs.order?.[slot];
  const pinned = prefs.pinned?.[slot] ?? [];
  const pinIndex = (pluginId: string) => pinned.indexOf(mountKey(pluginId, slot));
  const rank = (pluginId: string) => {
    const index = order?.indexOf(mountKey(pluginId, slot)) ?? -1;
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  return enabledPluginsOf(prefs, plugins)
    .flatMap((plugin) =>
      plugin.mounts
        .filter((mount) => mount.slot === slot && isMountVisible(plugin, mount, prefs))
        .map((mount) => ({ plugin, mount })),
    )
    .sort((a, b) => {
      const left = pinIndex(a.plugin.id);
      const right = pinIndex(b.plugin.id);
      if (left !== right) {
        if (left < 0) return 1;
        if (right < 0) return -1;
        return left - right;
      }
      return rank(a.plugin.id) - rank(b.plugin.id);
    });
}

export function findPluginCommand(
  plugin: PluginDefinition,
  commandId: string,
): PluginCommand | undefined {
  return plugin.commands?.find((command) => command.id === commandId);
}

/** 生成左导航条目：路由型按路由名判激活，命令型调用 command.isActive(ctx)。 */
export function navPluginEntries(
  prefs: PluginUserState,
  currentRouteName: string | undefined,
  ctx: PluginContext | undefined,
  plugins: readonly PluginDefinition[],
): PluginNavEntry[] {
  return activeMounts('left-nav', prefs, plugins).map(({ plugin, mount }) => {
    const navMount = mount as Extract<PluginMount, { slot: 'left-nav' }>;
    if ('route' in navMount) {
      return {
        id: plugin.id,
        route: navMount.route,
        label: plugin.name,
        icon: plugin.icon,
        current: navMount.route === currentRouteName,
      };
    }
    const command = findPluginCommand(plugin, navMount.command);
    return {
      id: plugin.id,
      command: navMount.command,
      label: plugin.name,
      icon: plugin.icon,
      current: Boolean(ctx && command?.isActive?.(ctx)),
    };
  });
}

/** 收集所有插件声明的全局路由，供路由器启动时注册。 */
export function collectPluginRoutes(
  plugins: readonly PluginDefinition[],
): Array<{ plugin: PluginDefinition; route: NonNullable<PluginDefinition['routes']>[number] }> {
  return plugins.flatMap((plugin) =>
    (plugin.routes ?? []).map((route) => ({ plugin, route })),
  );
}

/** 按当前路由名查找匹配的插件路由及启用状态。 */
export function activePluginRoute(
  routeName: string | undefined,
  prefs: PluginUserState,
  plugins: readonly PluginDefinition[],
): ResolvedPluginRoute | null {
  if (!routeName) return null;
  for (const plugin of plugins) {
    const matched = plugin.routes?.find((route) => route.name === routeName);
    if (matched) {
      return {
        plugin,
        route: matched,
        enabled: !prefs.disabled?.[plugin.id],
      };
    }
  }
  return null;
}

/** 收集当前启用插件声明的所有常驻浮层组件。 */
export function collectPluginOverlays(
  prefs: PluginUserState,
  plugins: readonly PluginDefinition[],
): RegisteredPluginOverlay[] {
  return enabledPluginsOf(prefs, plugins).flatMap((plugin) =>
    (plugin.overlays ?? []).map((component, index) => ({
      key: `${plugin.id}:overlay:${index}`,
      pluginId: plugin.id,
      component,
    })),
  );
}

/** 收集当前启用插件声明的所有命令（用于全局快捷键分发）。 */
export function collectPluginCommands(
  prefs: PluginUserState,
  plugins: readonly PluginDefinition[],
): RegisteredPluginCommand[] {
  return enabledPluginsOf(prefs, plugins).flatMap((plugin) =>
    (plugin.commands ?? []).map((command) => ({ plugin, command })),
  );
}

/** 收集当前启用插件声明的所有搜索 Provider，自动补齐归属 pluginId。 */
export function collectSearchProviders(
  prefs: PluginUserState,
  plugins: readonly PluginDefinition[],
): SearchProvider[] {
  return enabledPluginsOf(prefs, plugins).flatMap((plugin) =>
    (plugin.searchProviders ?? []).map((provider) => ({
      ...provider,
      pluginId: provider.pluginId ?? plugin.id,
    })),
  );
}

/** 收集所有已注册插件的静态搜索条目（含所属 pluginId），用于过滤禁用期间的最近访问。 */
export function allPluginStaticEntries(
  plugins: readonly PluginDefinition[],
): Array<NonNullable<SearchProvider['static']>[number]> {
  return plugins.flatMap((plugin) =>
    (plugin.searchProviders ?? []).flatMap((provider) =>
      (provider.static ?? []).map((entry) => ({
        ...entry,
        pluginId: entry.pluginId ?? plugin.id,
      })),
    ),
  );
}

/** 判断键盘事件是否命中命令声明的快捷键（Meta/Ctrl + key，忽略额外 Alt/Shift）。 */
export function matchHotkey(event: KeyboardEvent, hotkey: PluginHotkey): boolean {
  if (!hotkey.mod) return false;
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  return event.key.toLowerCase() === hotkey.key.toLowerCase();
}
