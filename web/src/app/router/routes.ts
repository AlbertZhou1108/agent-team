import type { RouteRecordRaw } from 'vue-router';
import { collectPluginRoutes } from '@/plugins';

const pluginRoutes: RouteRecordRaw[] = collectPluginRoutes().map(({ plugin, route }) => ({
  path: route.path,
  name: route.name,
  component: () => import('@/pages/GroupWorkspacePage.vue'),
  meta: { pluginId: plugin.id },
}));

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/agent',
  },
  {
    path: '/agent',
    name: 'panel-agent',
    component: () => import('@/pages/GroupWorkspacePage.vue'),
  },
  {
    path: '/groups/new',
    name: 'create-team',
    component: () => import('@/pages/GroupWorkspacePage.vue'),
  },
  {
    path: '/groups/:groupId?',
    name: 'group',
    component: () => import('@/pages/GroupWorkspacePage.vue'),
  },
  ...pluginRoutes,
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/pages/GroupWorkspacePage.vue'),
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/pages/NotFoundPage.vue'),
  },
];
