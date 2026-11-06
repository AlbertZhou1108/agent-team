import { watch, watchEffect } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { api, ApiError } from '@/shared/api/client';
import { useConnectionStore } from '@/stores/connection';
import { notifyInteraction } from '@/features/messages/interaction-notification';
import type { Group } from '@/shared/api/raw-types';
import type { TeamQueries, TeamQueriesOptions } from './use-team-queries';
import type { TeamDerived } from './use-team-derived';

/**
 * 团队工作区的副作用层：连接状态上报、新互动卡通知、消息锚点续载、路由纠偏，
 * 以及需要「刷新全部工作区资源」的动作（保存模型策略、恢复归档团队）。
 * 只读查询/派生状态，不创建新查询。
 */
export function useTeamNotifications(
  options: TeamQueriesOptions,
  queries: TeamQueries,
  derived: TeamDerived,
) {
  const route = useRoute();
  const router = useRouter();
  const connection = useConnectionStore();
  const { groupId } = options;

  watchEffect(() => {
    // 连接状态只由基础导航和主体资源判断；局部面板失败不阻断页面。
    const failure = queries.navigationState.error.value ?? queries.workspaceState.error.value;
    if (failure) connection.failed(failure);
    else if (queries.navigationState.data.value && queries.workspaceState.data.value)
      connection.online();
  });

  // 新互动卡等待答复时提醒；点击跳到卡片所在视图，已在目标页则不跳转。
  const seenPendingInteractions = new Set<string>();
  let interactionsPrimed = false;
  watch(queries.interactionsQuery.data, (rows) => {
    const pending = (rows ?? []).filter((item) => item.state === 'pending');
    if (!interactionsPrimed) {
      interactionsPrimed = true;
      for (const item of pending) seenPendingInteractions.add(item.id);
      return;
    }
    for (const item of pending) {
      if (seenPendingInteractions.has(item.id)) continue;
      seenPendingInteractions.add(item.id);
      const requester = item.member_id
        ? queries.members.value.find((member) => member.id === item.member_id)
        : null;
      const name = item.member_id
        ? (requester?.name ?? item.member_id)
        : 'Panel Agent';
      notifyInteraction(name, item.payload.text, async () => {
        const target = item.member_id
          ? await api.sessionTarget(
              item.group_id || groupId.value,
              item.member_id,
              requester?.role === 'lead' ? 'coordination' : 'pair:user',
            )
          : null;
        return router.push({
          name: 'group',
          params: { groupId: item.group_id || groupId.value },
          query: {
            session: target?.id,
            interaction: item.id,
          },
        });
      });
    }
  });

  // Load older history until the linked interaction's anchor can render.
  watch(
    [
      () => route.query.interaction,
      () => route.query.message,
      queries.messagesQuery.rows,
      queries.interactionsQuery.data,
      queries.messagesQuery.isPending,
      queries.messagesQuery.isFetchingNextPage,
    ],
    async () => {
      const id = routeString(route.query.interaction);
      const item = queries.interactionsQuery.data.value?.find(
        (row) => row.id === id,
      );
      const anchorId = item?.message_id ?? routeString(route.query.message);
      if (
        !anchorId ||
        queries.messagesQuery.isPending.value ||
        queries.messagesQuery.isFetchingNextPage.value
      )
        return;
      if (queries.messagesQuery.rows.value.some((row) => row.id === anchorId))
        return;
      if (queries.messagesQuery.hasNextPage.value)
        await queries.messagesQuery.fetchNextPage();
    },
    { immediate: true },
  );

  watch(
    [derived.groups, groupId],
    ([items, id]) => {
      // 等导航数据就绪后再处理不存在的团队。
      if (
        !queries.overview.value ||
        queries.navigationState.isPending.value ||
        !id ||
        items.some((item) => item.id === id)
      )
        return;
      router.replace({ name: 'group' });
    },
    { immediate: true },
  );
  watch(
    () => queries.detailQuery.error.value,
    (error) => {
      if (error instanceof ApiError && error.status === 410)
        void router.replace({ name: 'group' });
    },
  );
  watch(
    () => queries.sessionQuery.error.value,
    (error) => {
      if (!(error instanceof ApiError) || error.status !== 404) return;
      const query = { ...route.query };
      delete query.session;
      delete query.tab;
      void router.replace({ query });
    },
  );

  async function modelPolicySaved() {
    await queries.refreshResources();
    toast.success('全局模型策略已保存', {
      description: '将用于新团队初始角色和已有团队新增角色',
    });
  }

  async function restoreArchivedTeam(team: Group) {
    try {
      await api.restoreTeam(team.id);
      // 刷新团队导航、详情和运行状态。
      await queries.refreshResources();
      toast.success(`已恢复 ${team.name}`);
    } catch (error) {
      toast.error('恢复团队失败', { description: String(error) });
    }
  }

  return { modelPolicySaved, restoreArchivedTeam };
}

function routeString(value: unknown) {
  return Array.isArray(value)
    ? String(value[0] ?? '')
    : typeof value === 'string'
      ? value
      : '';
}

export type TeamNotifications = ReturnType<typeof useTeamNotifications>;
