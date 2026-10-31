import { watchEffect } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import { queryKeys } from '@/features/query-keys';
import { resolveDark, usePreferencesStore } from '@/stores/preferences';
import { applyTheme } from './apply';
import { resolveThemePack, resolveTokens } from './resolve';

/**
 * 主题应用收口:监听偏好(明暗模式/选中主题)与服务端主题包列表,
 * 把最终 token 写到 <html>。在 App.vue 挂载时启动一次;
 * 首帧之前的同步应用由 main.ts 用快照完成,这里负责其后的所有变更。
 */
export function startThemeApplication() {
  const preferences = usePreferencesStore();
  const packsQuery = useQuery({
    queryKey: queryKeys.themePacks,
    queryFn: ({ signal }) => api.themePacks(signal),
  });

  const apply = () => {
    const isDark = resolveDark(preferences.colorMode);
    const pack = resolveThemePack(preferences.themePack, packsQuery.data.value ?? []);
    applyTheme(resolveTokens(pack, isDark), isDark);
  };

  watchEffect(apply);
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', apply);
}
