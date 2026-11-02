import type { RouteRecordRaw } from 'vue-router';

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
