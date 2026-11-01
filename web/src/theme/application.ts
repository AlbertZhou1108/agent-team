import { watchEffect } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import { queryKeys } from '@/features/query-keys';
import {
  resolveDark,
  usePreferencesStore,
} from '@/stores/preferences';
import { applyAppearance } from './apply';
import { resolveThemePack, resolveTokens } from './resolve';

/**
 * 外观应用收口:监听偏好(明暗模式/主题/动效)与服务端主题包列表,
 * 把最终 token 与动效风格写到 <html>。在 App.vue 挂载时启动一次;
 * 首帧之前的同步应用由 main.ts 用快照完成,这里负责其后的所有变更。
 */
export function startThemeApplication() {
  const preferences = usePreferencesStore();
  const packsQuery = useQuery({
    queryKey: queryKeys.themePacks,
    queryFn: ({ signal }) => api.themePacks(signal),
  });

  const apply = () => {
    // 解析链(设计逻辑框架 §5):环境约束(第 0 步,媒体查询与监听)之后 ——
    // 由统一 applyAppearance 解析并输出;首帧也消费同一过程。
    const isDark = resolveDark(preferences.colorMode);
    const pack = resolveThemePack(preferences.themePack, packsQuery.data.value ?? []);
    applyAppearance(preferences, resolveTokens(pack, isDark), isDark);
  };

  watchEffect(apply);
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', apply);
  // 跟随系统的动效偏好也要响应系统减少动态效果变化。
  window
    .matchMedia('(prefers-reduced-motion: reduce)')
    .addEventListener('change', apply);
  // 系统降低透明度时材质回落实色,恢复时再切回。
  window
    .matchMedia('(prefers-reduced-transparency: reduce)')
    .addEventListener('change', apply);
}
