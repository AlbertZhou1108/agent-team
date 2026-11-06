import { createSSRApp, type Component } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { renderToString } from 'vue/server-renderer';
import { createPinia } from 'pinia';
import { vi } from 'vitest';

/**
 * 页面级 SSR 冒烟测试的共用辅助。
 *
 * 三个页面都挂在 `app/router/routes.ts` 的同一组路由名下；这里用同名占位路由，
 * 避免为了测试整包加载真实页面（懒加载会再次 import 被测页面）。SSR 下
 * `onMounted` 不执行，因此不会真的建连接/发请求。
 */

const Null = { render: () => null };

const pageRoutes = [
  { path: '/agent', name: 'panel-agent', component: Null },
  { path: '/groups/new', name: 'create-team', component: Null },
  { path: '/groups/:groupId?', name: 'group', component: Null },
  { path: '/notes', name: 'notes', component: Null },
  { path: '/settings', name: 'settings', component: Null },
];

/** Pinia store 在 state 初始化时读 localStorage；SSR 测试用空存储。 */
export function stubSsrBrowser() {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  // setup 期可能排帧（如流层），SSR 不执行渲染帧；给同步 no-op 即可。
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
}

export async function renderPage(component: Component, path: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: pageRoutes,
  });
  await router.push(path);
  await router.isReady();
  const app = createSSRApp(component);
  app.use(createPinia());
  app.use(router);
  return { html: await renderToString(app), router };
}
