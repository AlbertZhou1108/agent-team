<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import type {
  ModelCatalogResponse,
  PanelAgent,
  PanelStream,
  PanelTeamView,
} from '@/shared/api/raw-types';
import { api } from '@/shared/api/client';
import { usePanelAgentQuery } from '@/features/queries';
import { usePanelAgentStore } from '@/stores/panel-agent';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import PanelAgentChat from './PanelAgentChat.vue';
import PanelAgentSetup from './PanelAgentSetup.vue';
import PanelAgentSidebar from './PanelAgentSidebar.vue';
import type { AvailableHost, PanelAction, PanelAgentForm } from './types';

const router = useRouter();
const route = useRoute();
const panelState = usePanelAgentStore();
const panelQuery = usePanelAgentQuery();
const panel = computed(() => panelQuery.data.value ?? null);
const catalog = ref<ModelCatalogResponse | null>(null);
const catalogLoading = ref(false);
const catalogError = ref('');
const editing = ref(false);
const saving = ref(false);
const modelSaving = ref(false);
const stopping = ref(false);
const actionError = ref('');
const streamedReply = ref<PanelStream | null>(null);
let streamSource: EventSource | null = null;

type ConfirmRequest = {
  title: string;
  description: string;
  confirmText: string;
  destructive?: boolean;
  run: () => Promise<void>;
};
const confirmRequest = ref<ConfirmRequest | null>(null);

function askConfirm(request: ConfirmRequest) {
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
const draft = computed({
  get: () => panelState.draft,
  set: (value) => panelState.setDraft(value),
});
const activeTeamId = computed({
  get: () => panelState.activeTeamId,
  set: (value) => panelState.setActiveTeamId(value),
});
const privateSessionId = computed(
  () =>
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
    (streamedReply.value?.context === 'private'
      ? streamedReply.value
      : null) ??
    panel.value?.streaming?.find((stream) => stream.context === 'private') ??
    null,
);

function acceptPanelStream(payload: {
  type: 'snapshot' | 'start' | 'delta' | 'reasoning-delta' | 'complete' | 'cancelled' | 'error';
  stream?: PanelStream;
  streams?: PanelStream[];
  delta?: string;
}) {
  if (payload.type === 'snapshot') {
    streamedReply.value =
      payload.streams?.find((stream) => stream.context === 'private') ?? null;
    return;
  }
  if (payload.stream?.context !== 'private') return;
  const sameTurn = streamedReply.value?.turnId === payload.stream.turnId;
  if (payload.type === 'delta' && typeof payload.delta === 'string') {
    streamedReply.value = {
      ...payload.stream,
      text: (sameTurn ? streamedReply.value?.text ?? '' : '') + payload.delta,
      reasoning: sameTurn ? streamedReply.value?.reasoning ?? '' : '',
    };
    return;
  }
  if (payload.type === 'reasoning-delta' && typeof payload.delta === 'string') {
    streamedReply.value = {
      ...payload.stream,
      text: sameTurn ? streamedReply.value?.text ?? '' : '',
      reasoning:
        (sameTurn ? streamedReply.value?.reasoning ?? '' : '') + payload.delta,
    };
    return;
  }
  if (payload.type === 'complete') {
    streamedReply.value = payload.stream;
    void panelQuery.refetch().finally(() => {
      streamedReply.value = null;
    });
  } else if (payload.type === 'cancelled' || payload.type === 'error') {
    streamedReply.value = null;
    void panelQuery.refetch();
  } else {
    streamedReply.value = payload.stream;
  }
}

onMounted(() => {
  streamSource = new EventSource('/api/panel-agent/events');
  streamSource.addEventListener('panel-stream', (event) => {
    try {
      acceptPanelStream(JSON.parse((event as MessageEvent<string>).data));
    } catch {
      // A malformed event is ignored; the next delta or state poll is authoritative.
    }
  });
});

onBeforeUnmount(() => {
  streamSource?.close();
  streamSource = null;
});
const sending = computed(
  () =>
    panelState.submitting ||
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
      .map((host) => ({
        host: host.host,
        catalog: host.catalog!,
      })) ?? [],
);
const pendingActions = computed<PanelAction[]>(
  () =>
    panel.value?.actions.filter((action) => action.state === 'pending') ?? [],
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
    catalog.value = await api.modelCatalog(force);
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
    !form.value.model ||
    !form.value.reasoning_effort
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
    toast.success(
      wasExisting ? 'Panel Agent 配置已更新' : 'Panel Agent 已创建',
    );
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

async function sendMessage() {
  const text = panelState.draft.trim();
  if (!text || sending.value || !panel.value?.agent) return;
  actionError.value = '';
  try {
    const pending = panelState.sendMessage(text, activeTeamId.value || null);
    // The user message is persisted before the host starts. Refresh now so it
    // appears alongside the first SSE delta instead of waiting for completion.
    await panelQuery.refetch();
    const response = await pending;
    await panelQuery.refetch();
    // Creating a team rebinds the turn context server-side; follow it so the
    // next message continues inside the new team without a manual switch.
    if (response?.activeTeamId && response.activeTeamId !== activeTeamId.value) {
      activeTeamId.value = response.activeTeamId;
    }
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

function decideAction(id: string, approved: boolean) {
  const action = pendingActions.value.find((item) => item.id === id);
  if (!action) return;
  const team = panel.value?.teams.find((item) => item.id === action.group_id);
  const label = action.action === 'takeover' ? '接管' : '交还';
  askConfirm({
    title: `${approved ? '确认' : '取消'}${label}“${team?.name ?? action.group_id}”？`,
    description: approved ? '确认后将执行该操作。' : '取消后该操作请求将被拒绝。',
    confirmText: approved ? '确认' : '确认取消',
    run: async () => {
      actionError.value = '';
      try {
        await api.decidePanelAction(id, approved);
        await panelQuery.refetch();
        toast.success(approved ? `${label}操作已完成` : '操作请求已取消');
      } catch (error) {
        actionError.value = error instanceof Error ? error.message : String(error);
      }
    },
  });
}

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

function syncTeamQuery(id: string) {
  const current = typeof route.query.team === 'string' ? route.query.team : '';
  if (current === id) return;
  const query = { ...route.query };
  if (id) query.team = id;
  else delete query.team;
  router.replace({ query });
}

watch(
  () => route.query.team,
  (value) => {
    const teamId = typeof value === 'string' ? value : '';
    if (teamId && teamId !== panelState.activeTeamId)
      panelState.setActiveTeamId(teamId);
  },
  { immediate: true },
);

watch(activeTeamId, (id) => {
  if (!panel.value) return;
  if (id && !panel.value.teams.some((team) => team.id === id)) {
    panelState.setActiveTeamId('');
    return;
  }
  syncTeamQuery(id);
});

watch(
  () => panel.value?.teams,
  (teams) => {
    if (!teams) return;
    const id = panelState.activeTeamId;
    if (id && !teams.some((team) => team.id === id))
      panelState.setActiveTeamId('');
    else if (id) syncTeamQuery(id);
  },
  { immediate: true },
);

watch(
  [() => panelQuery.isPending.value, () => panel.value?.agent],
  ([loading]) => {
    if (!loading) loadCatalog();
  },
  { immediate: true },
);
</script>

<template>
  <TooltipProvider>
    <section class="panel-agent-page">
      <Card v-if="panelQuery.isPending.value" class="panel agent-state-panel">
        <CardContent>
          <LoaderCircle class="animate-spin" />
          <p class="text-sm text-muted-foreground">正在读取 Panel Agent…</p>
        </CardContent>
      </Card>

      <Card v-else-if="panelQuery.error.value" class="panel agent-state-panel">
        <CardContent>
          <Alert
            variant="destructive"
            class="error-banner w-full max-w-xl"
            role="alert"
            ><AlertDescription class="flex items-center gap-2">
              <span class="min-w-0 flex-1">{{
                panelQuery.error.value.message
              }}</span>
              <Button variant="outline" size="sm" @click="panelQuery.refetch()"
                >重试</Button
              >
            </AlertDescription></Alert
          >
        </CardContent>
      </Card>

      <PanelAgentSetup
        v-else-if="!panel?.agent || editing"
        v-model:form="form"
        :agent="panel?.agent ?? null"
        :hosts="availableHosts"
        :catalog-loading="catalogLoading"
        :catalog-error="catalogError"
        :action-error="actionError"
        :saving="saving"
        @save="saveAgent"
        @cancel="cancelEdit"
        @retry="loadCatalog(true)"
      />

      <div v-else class="agent-workspace">
        <PanelAgentChat
          v-model:draft="draft"
          v-model:active-team-id="activeTeamId"
          v-model:form="form"
          :agent="panel.agent"
          :messages="panel.conversation"
          :streaming="privateStreaming"
          :teams="panel.teams"
          :sending="sending"
          :context-running="contextRunning"
          :stopping="stopping"
          :action-error="conversationError"
          :hosts="availableHosts"
          :catalog-loading="catalogLoading"
          :model-saving="modelSaving"
          @send="sendMessage"
          @stop="stopTurn"
          @edit="beginEdit"
          @update-model="updateAgentModel"
        />
        <PanelAgentSidebar
          v-model="activeTeamId"
          :teams="panel.teams"
          :pending-actions="pendingActions"
          :unknown="panel.unknown"
          @open-team="openTeam"
          @takeover="takeover"
          @handback="handback"
          @decide-action="decideAction"
          @resolve-runtime="resolveRuntime"
        />
      </div>

      <ConfirmDialog
        :open="confirmRequest !== null"
        :title="confirmRequest?.title ?? ''"
        :description="confirmRequest?.description ?? ''"
        :confirm-text="confirmRequest?.confirmText ?? '确认'"
        :destructive="confirmRequest?.destructive ?? false"
        @confirm="runConfirm"
        @cancel="cancelConfirm"
      />
    </section>
  </TooltipProvider>
</template>
