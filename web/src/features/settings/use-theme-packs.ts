// 主题包：内置（不可删）与用户上传（可删）混排在一条轨道上。
//
// 从 SettingsDialog 抽出来是因为这块与「外观/通用/策略/团队」四个 tab 无关：
// 它只依赖偏好存储与主题包接口，抽走后可以单独测上传校验与删除保护。

import { computed, nextTick, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { api } from '@/shared/api/client';
import { queryKeys } from '@/features/query-keys';
import { usePreferencesStore, resolveDark } from '@/stores/preferences';
import { BUILTIN_THEME_PACKS } from '@/theme/builtin';
import { THEME_TEMPLATE_JSON } from '@/theme/template';
import { parseThemePackJson } from '@/theme/validate';
import type { ThemePack, UserThemePack } from '@/theme/tokens';
import { prefersReducedMotion } from '@/shared/motion';

export function useThemePacks() {
  const preferences = usePreferencesStore();
  const themePacksQuery = useQuery({
    queryKey: queryKeys.themePacks,
    queryFn: ({ signal }) => api.themePacks(signal),
  });
  const userThemePacks = computed(() => themePacksQuery.data.value ?? []);
  const allThemePacks = computed(() => [...BUILTIN_THEME_PACKS, ...userThemePacks.value]);
  const themeOpen = ref(true);
  const themePreviewDark = computed(() => resolveDark(preferences.colorMode));
  const isBuiltinTheme = (pack: ThemePack) =>
    BUILTIN_THEME_PACKS.some((item) => item.id === pack.id);

  // 色板预览跟随当前明暗模式；点击即切换并缓存快照（刷新首帧用）。
  function selectTheme(pack: ThemePack) {
    preferences.setThemePack(pack.id, { light: pack.light, dark: pack.dark });
  }
  function themeSwatches(pack: ThemePack) {
    const tokens = themePreviewDark.value ? pack.dark : pack.light;
    return [
      { key: 'background', value: tokens.background, divider: true },
      { key: 'card', value: tokens.card, divider: true },
      { key: 'primary', value: tokens.primary, divider: true },
      { key: 'accent', value: tokens.accent, divider: true },
      { key: 'success', value: tokens.success, divider: false },
    ];
  }

  // 轨道轮播：左右按钮按视口 80% 滚动，到端点禁用。
  const themeTrack = ref<HTMLElement | null>(null);
  const canScrollThemeLeft = ref(false);
  const canScrollThemeRight = ref(false);
  function updateThemeCarousel() {
    const track = themeTrack.value;
    if (!track) {
      canScrollThemeLeft.value = false;
      canScrollThemeRight.value = false;
      return;
    }
    canScrollThemeLeft.value = track.scrollLeft > 1;
    canScrollThemeRight.value = track.scrollLeft + track.clientWidth < track.scrollWidth - 1;
  }
  function scrollThemeTrack(direction: -1 | 1) {
    const track = themeTrack.value;
    track?.scrollBy({ left: direction * track.clientWidth * 0.8, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
  watch([userThemePacks, themeOpen], () => nextTick(updateThemeCarousel), { immediate: true });

  // 新增主题：弹窗提供样板下载（带注释，即文档）与拖拽/点击上传；校验错误内联展示。
  const addThemeOpen = ref(false);
  const addThemeError = ref('');
  const uploadingTheme = ref(false);
  function beginAddTheme() {
    addThemeError.value = '';
    addThemeOpen.value = true;
  }
  function downloadThemeTemplate() {
    const blob = new Blob([THEME_TEMPLATE_JSON], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'agent-team-theme-template.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }
  async function onThemeFiles(files: File[]) {
    const file = files[0];
    if (!file) return;
    addThemeError.value = '';
    let text: string;
    try {
      text = await file.text();
    } catch {
      addThemeError.value = '无法读取所选文件';
      return;
    }
    const parsed = parseThemePackJson(text);
    if (!parsed.ok) {
      addThemeError.value = parsed.error;
      return;
    }
    uploadingTheme.value = true;
    try {
      await api.createThemePack({
        name: parsed.pack.name,
        light: JSON.stringify(parsed.pack.light),
        dark: JSON.stringify(parsed.pack.dark),
      });
      addThemeOpen.value = false;
      await themePacksQuery.refetch();
      toast.success('主题已导入');
    } catch (cause) {
      addThemeError.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      uploadingTheme.value = false;
    }
  }

  // 删除：使用中的禁删（按钮禁用）；跨设备删除由「缺 id 回落内置」兜底。
  const deletingTheme = ref<UserThemePack | null>(null);
  function requestDeleteTheme(pack: ThemePack) {
    // 内置包不渲染删除按钮，这里再挡一道；能走到这里的必然是用户包。
    if (isBuiltinTheme(pack)) return;
    deletingTheme.value = pack as UserThemePack;
  }
  async function confirmDeleteTheme() {
    if (!deletingTheme.value) return;
    try {
      await api.deleteThemePack(deletingTheme.value.id);
      deletingTheme.value = null;
      await themePacksQuery.refetch();
      toast.success('主题已删除');
    } catch (cause) {
      toast.error('删除失败', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return {
    allThemePacks, themeOpen, isBuiltinTheme, selectTheme, themeSwatches,
    themeTrack, canScrollThemeLeft, canScrollThemeRight, updateThemeCarousel, scrollThemeTrack,
    addThemeOpen, addThemeError, uploadingTheme, beginAddTheme, downloadThemeTemplate, onThemeFiles,
    deletingTheme, requestDeleteTheme, confirmDeleteTheme,
  };
}
