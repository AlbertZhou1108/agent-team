import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import App from './App.vue';
import { installTabCache } from './shared/api/tab-cache';
import { router } from './app/router';
import { resolveDark, usePreferencesStore } from './stores/preferences';
import { applyAppearance } from './theme/apply';
import { resolveThemePack, resolveTokens } from './theme/resolve';
import '@fontsource-variable/noto-sans-sc';
import '@fontsource-variable/geist';
import '@fontsource/fira-code/400.css';
import './styles/globals.css';

function showFatal(error: unknown) {
  const root = document.querySelector('#app');
  if (!root) return;
  // 致命屏必须自给自足:此时主题 token 可能尚未应用(甚至正是应用过程本身抛错),
  // 不能依赖任何语义变量或全局类,配色用字面量内联(本文件不在设计门禁扫描范围)。
  root.innerHTML = `
    <main style="min-height:100vh;display:grid;place-items:center;padding:0 24px;background:#f4f4f5">
      <section style="width:100%;max-width:36rem;padding:32px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px">
        <p style="margin:0;font-size:11px;letter-spacing:.08em;color:#71717a">PANEL ERROR</p>
        <h1 style="margin:8px 0 0;font-size:24px;font-weight:600;color:#111827">面板启动失败</h1>
        <p style="margin:12px 0 0;font-size:14px;line-height:1.75;color:#52525b">请刷新页面；若问题持续，请检查服务端日志和浏览器控制台。</p>
        <pre style="margin:16px 0 0;max-height:14rem;overflow:auto;padding:12px;border-radius:8px;background:#18181b;color:#e4e4e7;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap"></pre>
      </section>
    </main>`;
  const detail = root.querySelector('pre');
  if (detail)
    detail.textContent =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
}

try {
  const pinia = createPinia();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: Infinity,
        staleTime: 1000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });

  try { installTabCache(queryClient, window.sessionStorage, window); } catch { /* Keep in-memory caching when storage is unavailable. */ }

  const app = createApp(App);
  app.config.errorHandler = (error) => showFatal(error);
  app.use(pinia);
  app.use(router);
  app.use(VueQueryPlugin, { queryClient });

  const preferences = usePreferencesStore(pinia);

  // 首帧同步应用:用选中包的快照兜底,避免自定义主题在请求返回前闪默认色;
  // 之后的全部变更(偏好、包列表、系统明暗)由 App.vue 的主题应用收口处理。
  const snapshotPacks = preferences.themePackSnapshot
    ? [
        {
          id: preferences.themePack,
          name: '',
          light: preferences.themePackSnapshot.light,
          dark: preferences.themePackSnapshot.dark,
        },
      ]
    : [];
  const isDark = resolveDark(preferences.colorMode);
  applyAppearance(preferences, resolveTokens(resolveThemePack(preferences.themePack, snapshotPacks), isDark), isDark);

  app.mount('#app');
} catch (error) {
  showFatal(error);
  throw error;
}
