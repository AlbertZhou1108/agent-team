import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import App from './App.vue';
import { installTabCache } from './shared/api/tab-cache';
import { router } from './app/router';
import { applyColorMode, usePreferencesStore } from './stores/preferences';
import '@fontsource-variable/noto-sans-sc';
import './styles/globals.css';

function showFatal(error: unknown) {
  const root = document.querySelector('#app');
  if (!root) return;
  root.innerHTML = `
    <main class="grid min-h-screen place-items-center px-6">
      <section class="panel w-full max-w-xl p-8">
        <p class="eyebrow">PANEL ERROR</p>
        <h1 class="mt-2 text-2xl font-semibold">面板启动失败</h1>
        <p class="mt-3 text-sm leading-7 text-muted">请刷新页面；若问题持续，请检查服务端日志和浏览器控制台。</p>
        <pre class="mt-4 max-h-56 overflow-auto rounded-lg bg-[var(--code)] p-3 font-mono text-[11px] text-[var(--code-foreground)]"></pre>
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
  applyColorMode(preferences.colorMode);

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handleSystemTheme = () => {
    if (preferences.colorMode === 'system') applyColorMode('system');
  };
  media.addEventListener('change', handleSystemTheme);

  app.mount('#app');
} catch (error) {
  showFatal(error);
  throw error;
}
