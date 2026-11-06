import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { useQuery } from '@tanstack/vue-query';
import { notifyInteraction } from '@/features/messages/interaction-notification';
import { queryKeys } from '@/features/query-keys';
import { usePanelAgentQuery, usePanelInteractionsQuery } from '@/features/queries';
import { api } from '@/shared/api/client';
import { usePanelStream } from './panel-stream-store';
import { usePanelAgentStore } from '@/stores/panel-agent';
import { useUiStore } from '@/stores/ui';
import type {
  ModelCatalogResponse,
  PanelAgent,
  PanelTeamView,
} from '@/shared/api/raw-types';
import type { AvailableHost, PanelAgentForm } from './types';
/**
 * 私人助手页的视图状态 / 查询 / 动作（从 PanelAgentPanel.vue 纯搬迁）。
 *
 * 组件只保留模板与接线：本 composable 持有面板状态查询、配置表单与目录、
 * 附件与发送、接管/交还/清理通知/待核实运行等动作、统一 panel 流订阅，
 * 以及新互动卡通知 watch。对外仍由组件决定 props/emit/slot 与 aria 结构。
 */

export function usePanelAgentPage() {
  const router = useRouter();
  const route = useRoute();
  const panelState = usePanelAgentStore();
  const ui = useUiStore();
  const panelQuery = usePanelAgentQuery();
  const interactionsQuery = usePanelInteractionsQuery();
  const panel = computed(() => panelQuery.data.value ?? null);
  const catalog = ref<ModelCatalogResponse | null>(null);
  const catalogLoading = ref(false);
  const catalogError = ref('');
  const editing = ref(false);
  const saving = ref(false);
  const modelSaving = ref(false);
  const stopping = ref(false);
  const actionError = ref('');
  const panelStream = usePanelStream();
  const streamedReply = computed(() => panelStream.state.value.private);
  const confirmRequest = ref<{
    title: string;
    description: string;
    confirmText: string;
    destructive?: boolean;
    run: () => Promise<void>;
  } | null>(null);
  function askConfirm(request: NonNullable<typeof confirmRequest.value>) {
    confirmRequest.value = request;
  }
  function cancelConfirm() {
    confirmRequest.value = null;
  }
  async function runConfirm() {
    const request = confirmRequest.value;
    if (!request) return;
    confirmRequest.value = null;
    await request.run();
  }

  const draft = computed({ get: () => panelState.draft, set: (value) => panelState.setDraft(value) });
  const activeTeamId = computed({
    get: () => '',
    set: (value) => panelState.setActiveTeamId(value),
  });
  const privateSessionId = computed(() =>
    panel.value?.sessions.find((session) => session.context === 'private')?.id,
  );
  const privateRunningContext = computed(
    () =>
      panel.value?.running.find(
        (item) => item.endpoint === privateSessionId.value,
      )?.groupId ?? null,
  );
  const privateStreaming = computed(
    () =>
      streamedReply.value ??
      panel.value?.streaming?.find((stream) => stream.context === 'private') ??
      null,
  );

  // 面板流单例连接由 panel-stream-store 持有：本页只订阅统一 reducer 后的事件做刷新/清理。
  let releasePanelStream: () => void = () => {};
  let stopPanelStream: () => void = () => {};
  onMounted(() => {
    releasePanelStream = panelStream.retain();
    stopPanelStream = panelStream.subscribe((event) => {
      if (event.stream?.context !== 'private') return;
      if (event.type === 'complete') {
        void panelQuery.refetch().finally(() => panelStream.clearPrivate());
      } else if (event.type === 'cancelled' || event.type === 'error') {
        void panelQuery.refetch();
      }
    });
  });
  onBeforeUnmount(() => {
    stopPanelStream();
    releasePanelStream();
  });

  const sending = computed(
    () =>
      panelState.submitting ||
      panelState.attachments.some((item) => item.status === 'uploading') ||
      Boolean(
        privateSessionId.value &&
          panel.value?.running.some(
            (item) => item.endpoint === privateSessionId.value,
          ),
      ),
  );
  const contextRunning = computed(
    () =>
      Boolean(
        privateSessionId.value &&
          panel.value?.running.some(
            (item) => item.endpoint === privateSessionId.value,
          ),
      ) && privateRunningContext.value === (activeTeamId.value || null),
  );
  // 运行卡计时锚点取自服务端记录的回合创建时间,刷新或重连不会归零。
  const runningSince = computed(
    () =>
      panel.value?.running.find(
        (item) => item.endpoint === privateSessionId.value,
      )?.created ?? null,
  );
  const conversationError = computed(
    () => actionError.value || panelState.sendError,
  );
  const form = ref<PanelAgentForm>({
    name: 'Panel Agent',
    host: '',
    model_provider: '',
    model: '',
    reasoning_effort: '',
    workspace: '',
    access: 'read-only',
  });
  const availableHosts = computed<AvailableHost[]>(
    () =>
      catalog.value?.hosts
        .filter((host) => host.ok && host.catalog)
        .map((host) => ({ host: host.host, catalog: host.catalog! })) ?? [],
  );
  function formFromAgent(agent: PanelAgent): PanelAgentForm {
    return {
      name: agent.name,
      host: agent.host,
      model_provider: agent.model_provider ?? '',
      model: agent.model ?? '',
      reasoning_effort: agent.reasoning_effort ?? '',
      workspace: agent.workspace ?? '',
      access: agent.access ?? 'read-only',
    };
  }
  function selectDefaultModel(host: AvailableHost) {
    const model =
      host.catalog.models.find((item) => item.id === host.catalog.defaultModel) ??
      host.catalog.models.find((item) => item.isDefault) ??
      host.catalog.models[0];
    const efforts = model?.reasoningEfforts.length
      ? model.reasoningEfforts
      : host.catalog.reasoningEfforts;
    form.value = {
      ...form.value,
      host: host.host,
      model_provider: model?.provider ?? '',
      model: model?.id ?? '',
      reasoning_effort: model?.defaultReasoningEffort ?? efforts[0]?.id ?? '',
    };
  }
  async function loadCatalog(force = false) {
    if (catalog.value && !force) return;
    catalogLoading.value = true;
    catalogError.value = '';
    try {
      catalog.value = await api.modelCatalog(force, undefined, panel.value?.agent?.host || form.value.host || undefined);
      if (!form.value.host && availableHosts.value[0]) {
        selectDefaultModel(availableHosts.value[0]);
      }
    } catch (error) {
      catalogError.value = error instanceof Error ? error.message : String(error);
    } finally {
      catalogLoading.value = false;
    }
  }
  function beginEdit() {
    const agent = panel.value?.agent;
    if (!agent) return;
    form.value = formFromAgent(agent);
    editing.value = true;
    loadCatalog();
  }
  function cancelEdit() {
    editing.value = false;
    actionError.value = '';
  }
  async function saveAgent() {
    if (
      saving.value ||
      catalogLoading.value ||
      !form.value.name.trim() ||
      !form.value.host ||
      !form.value.model
    )
      return;
    if (form.value.access !== 'read-only' && !form.value.workspace.trim()) {
      actionError.value =
        '选择“工作区写入”或“完全权限”时，必须填写私人工作区绝对路径。';
      return;
    }
    saving.value = true;
    const wasExisting = Boolean(panel.value?.agent);
    actionError.value = '';
    try {
      const body = {
        name: form.value.name.trim(),
        host: form.value.host,
        model_provider: form.value.model_provider || null,
        model: form.value.model,
        reasoning_effort: form.value.reasoning_effort,
        workspace: form.value.workspace.trim() || null,
        access: form.value.access,
      };
      if (panel.value?.agent) await api.updatePanelAgent(body);
      else await api.createPanelAgent(body);
      editing.value = false;
      await panelQuery.refetch();
      toast.success(wasExisting ? 'Panel Agent 配置已更新' : 'Panel Agent 已创建');
    } catch (error) {
      actionError.value = error instanceof Error ? error.message : String(error);
    } finally {
      saving.value = false;
    }
  }
  async function updateAgentModel(next: PanelAgentForm) {
    const agent = panel.value?.agent;
    if (!agent || modelSaving.value) return;
    const previous = formFromAgent(agent);
    if (
      next.host === agent.host &&
      next.model === agent.model &&
      next.reasoning_effort === agent.reasoning_effort &&
      next.access === (agent.access ?? 'read-only')
    )
      return;
    modelSaving.value = true;
    actionError.value = '';
    try {
      await api.updatePanelAgent({
        name: agent.name,
        host: next.host,
        model_provider: next.model_provider || null,
        model: next.model,
        reasoning_effort: next.reasoning_effort || null,
        workspace: agent.workspace,
        access: next.access,
      });
      await panelQuery.refetch();
      toast.success('Panel Agent 配置已更新');
    } catch (error) {
      form.value = previous;
      actionError.value = error instanceof Error ? error.message : String(error);
    } finally {
      modelSaving.value = false;
    }
  }

  // 附件上传限额来自服务端设置;前端只做预检,服务端在提交时最终校验。
  const attachmentSettingsQuery = useQuery({
    queryKey: queryKeys.attachmentSettings,
    queryFn: ({ signal }) => api.attachmentSettings(signal),
  });
  async function onAttach(files: File[]) {
    const error = await panelState.addAttachmentFiles(files, attachmentSettingsQuery.data.value);
    if (error) toast.error(error);
  }
  async function onRemoveAttachment(localId: string) {
    await panelState.removeAttachment(localId);
  }
  async function sendMessage() {
    const text = panelState.draft.trim();
    // 附件-only 也是合法消息;上传中或失败时不发送。
    if ((!text && !panelState.attachments.length) || sending.value || !panel.value?.agent) return;
    if (panelState.attachments.some((item) => item.status !== 'ready')) return;
    actionError.value = '';
    try {
      const pending = panelState.sendMessage(text, null);
      // The user message is persisted before the host starts. Refresh now so it
      // appears alongside the first SSE delta instead of waiting for completion.
      await panelQuery.refetch();
      await pending;
      await panelQuery.refetch();
    } catch {
      /* The store keeps the error and restores the draft when needed. */
    }
  }
  async function stopTurn() {
    stopping.value = true;
    actionError.value = '';
    try {
      await api.stopPanel();
      await panelQuery.refetch();
    } catch (error) {
      actionError.value = error instanceof Error ? error.message : String(error);
    } finally {
      stopping.value = false;
    }
  }
  function takeover(team: PanelTeamView) {
    askConfirm({
      title: `让 Panel Agent 接管“${team.name}”？`,
      description: '原主 Agent 将暂停，Panel Agent 获得团队主控权。',
      confirmText: '接管',
      run: async () => {
        actionError.value = '';
        try {
          await api.takeoverTeam(team.id, team.controller.assignment?.revision ?? 0);
          await panelQuery.refetch();
          activeTeamId.value = team.id;
          toast.success(`Panel Agent 已接管 ${team.name}`);
        } catch (error) {
          actionError.value = error instanceof Error ? error.message : String(error);
        }
      },
    });
  }
  function handback(team: PanelTeamView) {
    askConfirm({
      title: `将“${team.name}”交还原主 Agent？`,
      description: 'Panel Agent 将回到观察状态。',
      confirmText: '交还',
      run: async () => {
        actionError.value = '';
        try {
          await api.handbackTeam(team.id, team.controller.assignment?.revision ?? 0);
          await panelQuery.refetch();
          toast.success(`已交还 ${team.name}`);
        } catch (error) {
          actionError.value = error instanceof Error ? error.message : String(error);
        }
      },
    });
  }
  const clearingNotifications = ref(false);
  /**
   * 清理团队来源通知:服务端只记录隐藏状态(panel:update),团队消息与投递台账
   * 都不删除,侧栏列表下一次读取就不再包含这些条目。
   */
  async function clearNotifications() {
    const ids = (panel.value?.notifications ?? []).map((row) => row.id);
    if (!ids.length || clearingNotifications.value) return;
    clearingNotifications.value = true;
    try {
      await api.dismissWorkbench(ids.map((id) => ({ category: 'panel:update' as const, id })));
      await panelQuery.refetch();
    } catch (error) {
      actionError.value = error instanceof Error ? error.message : String(error);
      toast.error('清理通知失败');
    } finally {
      clearingNotifications.value = false;
    }
  }
  function resolveRuntime(turnId: string) {
    askConfirm({
      title: '确认宿主进程已经实际停止？',
      description:
        '确认后，这个待核实运行将标记为已停止，团队可以继续调度。请先确认对应宿主进程已经实际停止。',
      confirmText: '确认已停止',
      run: async () => {
        actionError.value = '';
        try {
          await api.resolvePanelRuntime(turnId, '用户在面板中确认宿主进程已停止');
          await panelQuery.refetch();
          toast.success('运行状态已核实');
        } catch (error) {
          actionError.value = error instanceof Error ? error.message : String(error);
        }
      },
    });
  }

  // 新互动卡等待答复时提醒;点击跳到卡片所在视图,已在目标页则不跳转。
  const seenPendingInteractions = new Set<string>();
  let interactionsPrimed = false;
  watch(interactionsQuery.data, (rows) => {
    const pending = (rows ?? []).filter((item) => item.state === 'pending');
    if (!interactionsPrimed) {
      interactionsPrimed = true;
      for (const item of pending) seenPendingInteractions.add(item.id);
      return;
    }
    for (const item of pending) {
      if (seenPendingInteractions.has(item.id)) continue;
      seenPendingInteractions.add(item.id);
      // 协作发起(锚点是群消息)的卡在团队页;私聊发起(锚点是 panel 消息)的卡就在当前聊天。
      const coordinationOrigin = !item.panel_message_id && Boolean(item.group_id);
      const target = coordinationOrigin && item.group_id
        ? { name: 'group', params: { groupId: item.group_id }, query: { session: item.endpoint_id || undefined, interaction: item.id } }
        : { name: 'panel-agent', query: { team: item.group_id || undefined, interaction: item.id } };
      notifyInteraction(panel.value?.agent?.name ?? 'Panel Agent', item.payload.text, () => router.push(target));
    }
  });
  function openTeam(teamId: string) {
    router.push({ name: 'group', params: { groupId: teamId } });
  }
  watch(
    availableHosts,
    (hosts) => {
      if (!form.value.host && hosts[0]) selectDefaultModel(hosts[0]);
    },
    { immediate: true },
  );
  watch(
    () => panel.value?.agent,
    (agent) => {
      if (agent && !editing.value) form.value = formFromAgent(agent);
    },
    { immediate: true },
  );
  watch(() => route.query.team, (value) => {
    if (typeof value === 'string' && value) {
      router.replace({ name: 'group', params: { groupId: value }, query: { interaction: typeof route.query.interaction === 'string' ? route.query.interaction : undefined } });
    }
  }, { immediate: true });
  watch(
    [() => panelQuery.isPending.value, () => panel.value?.agent?.id],
    ([loading]) => {
      if (!loading && panel.value?.agent) {
        form.value = formFromAgent(panel.value.agent);
        void loadCatalog();
      }
    },
    { immediate: true },
  );

  return {
    panelQuery, panel, interactionsQuery, panelState, ui, editing, form,
    availableHosts, catalogLoading, catalogError, actionError, saving,
    modelSaving, stopping, sending, contextRunning, runningSince,
    conversationError, privateStreaming, clearingNotifications, confirmRequest,
    draft, activeTeamId, onAttach, onRemoveAttachment, sendMessage, stopTurn,
    beginEdit, cancelEdit, saveAgent, updateAgentModel, loadCatalog, openTeam,
    takeover, handback, resolveRuntime, clearNotifications, runConfirm, cancelConfirm,
  };
}
