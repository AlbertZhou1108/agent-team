import { useTeamQueries, type TeamQueriesOptions } from './use-team-queries';
import { useTeamDerived } from './use-team-derived';
import { useTeamNotifications } from './use-team-notifications';

export type TeamResourcesOptions = TeamQueriesOptions;

/**
 * 团队工作区数据组合根：查询编排（use-team-queries）、派生视图
 * （use-team-derived）、副作用（use-team-notifications）各自独立，本文件只做
 * 组合并维持对外返回值契约——页面组件的解构路径保持不变。
 */
export function useTeamResources(options: TeamResourcesOptions) {
  const queries = useTeamQueries(options);
  const derived = useTeamDerived(options, queries);
  const actions = useTeamNotifications(options, queries, derived);
  return {
    // 导航/目录
    allGroups: queries.allGroups,
    groups: derived.groups,
    archivedGroups: derived.archivedGroups,
    group: derived.group,
    members: queries.members,
    actors: queries.actors,
    overview: queries.overview,
    snapshot: queries.snapshot,
    navigationState: queries.navigationState,
    workspaceState: queries.workspaceState,
    refreshResources: queries.refreshResources,
    // 路由投影
    isPanelAgentRoute: derived.isPanelAgentRoute,
    isSettingsRoute: derived.isSettingsRoute,
    isNotesRoute: derived.isNotesRoute,
    sidebarGroupId: derived.sidebarGroupId,
    currentModelPolicy: derived.currentModelPolicy,
    modelPolicyDefaults: queries.modelPolicyDefaults,
    homeRunningByGroup: queries.homeRunningByGroup,
    runningEndpoints: queries.runningEndpoints,
    // 会话/成员
    currentControllerId: derived.currentControllerId,
    currentController: derived.currentController,
    pausedMemberIds: derived.pausedMemberIds,
    currentMembers: derived.currentMembers,
    currentEndpoints: derived.currentEndpoints,
    currentSessionBindings: derived.currentSessionBindings,
    selectedEndpoint: derived.selectedEndpoint,
    selectedPair: derived.selectedPair,
    selectedEndpointIsManagerPair: derived.selectedEndpointIsManagerPair,
    conversationTitle: derived.conversationTitle,
    endpointHosts: derived.endpointHosts,
    runningMemberIds: derived.runningMemberIds,
    // 消息
    panelMessages: derived.panelMessages,
    receiptRequests: derived.receiptRequests,
    agentUnreadCount: derived.agentUnreadCount,
    messagesQuery: queries.messagesQuery,
    directivesQuery: queries.directivesQuery,
    interactionsQuery: queries.interactionsQuery,
    messageViews: derived.messageViews,
    // 检查器
    turnsQuery: queries.turnsQuery,
    turnSummaries: derived.turnSummaries,
    unaffiliatedEvents: derived.unaffiliatedEvents,
    inspectorHasNextPage: derived.inspectorHasNextPage,
    inspectorFetchingNextPage: derived.inspectorFetchingNextPage,
    inspectorError: derived.inspectorError,
    contextError: derived.contextError,
    retryContext: derived.retryContext,
    loadInspectorMore: derived.loadInspectorMore,
    // 查询对象（模板/调试用）
    archivedQuery: queries.archivedQuery,
    sessionsQuery: queries.sessionsQuery,
    tasksQuery: queries.tasksQuery,
    agentTasksView: queries.agentTasksView,
    sessionQuery: queries.sessionQuery,
    // 工具导航
    notesTool: derived.notesTool,
    navToolEntries: derived.navToolEntries,
    notesPageComponent: derived.notesPageComponent,
    notesEnabled: derived.notesEnabled,
    // 动作
    modelPolicySaved: actions.modelPolicySaved,
    restoreArchivedTeam: actions.restoreArchivedTeam,
  };
}
