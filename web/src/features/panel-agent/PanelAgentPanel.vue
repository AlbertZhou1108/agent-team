<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LoaderCircle } from '@lucide/vue';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import PanelAgentChat from './PanelAgentChat.vue';
import PanelAgentSetup from './PanelAgentSetup.vue';
import FirstUseSetup from './FirstUseSetup.vue';
import PanelAgentSidebar from './PanelAgentSidebar.vue';
import { usePanelAgentPage } from './use-panel-agent-page';

/**
 * 私人助手页：只保留模板与组件接线。
 * 视图状态 / 查询 / 动作 / 面板流订阅全部在 usePanelAgentPage。
 */
const {
  panelQuery, panel, interactionsQuery, panelState, ui,
  editing, form, availableHosts, catalogLoading, catalogError,
  actionError, saving, modelSaving, stopping, sending,
  contextRunning, runningSince, conversationError, privateStreaming,
  clearingNotifications, confirmRequest, draft, activeTeamId,
  onAttach, onRemoveAttachment, sendMessage, stopTurn, beginEdit,
  cancelEdit, saveAgent, updateAgentModel, loadCatalog, openTeam,
  takeover, handback, resolveRuntime, clearNotifications,
  runConfirm, cancelConfirm,
} = usePanelAgentPage();
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

      <FirstUseSetup v-else-if="!panel?.agent" @created="panelQuery.refetch()" />
      <PanelAgentSetup
        v-else-if="editing"
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

      <div v-else class="agent-workspace" :class="{ 'agent-workspace-side-collapsed': ui.contextCollapsed }">
        <PanelAgentChat
          v-model:draft="draft"
          v-model:active-team-id="activeTeamId"
          v-model:form="form"
          :agent="panel.agent"
          :boot-id="panel.bootId"
          :messages="panel.conversation"
          :requests="panel.requests ?? []"
          :streaming="privateStreaming"
          :teams="panel.teams"
          :interactions="interactionsQuery.data.value ?? []"
          :sending="sending"
          :context-running="contextRunning"
          :running-since="runningSince"
          :stopping="stopping"
          :action-error="conversationError"
          :hosts="availableHosts"
          :catalog-loading="catalogLoading"
          :model-saving="modelSaving"
          :attachments="panelState.attachments"
          @attach="onAttach"
          @remove-attachment="onRemoveAttachment"
          @send="sendMessage"
          @stop="stopTurn"
          @edit="beginEdit"
          @update-model="updateAgentModel"
        />
        <PanelAgentSidebar
          v-model="activeTeamId"
          :teams="panel.teams"
          :messages="panel.conversation"
          :requests="panel.requests ?? []"
          :notifications="panel.notifications ?? []"
          :clearing-notifications="clearingNotifications"
          :pending-interactions="panel.teamPendingInteractions ?? {}"
          :unknown="panel.unknown"
          @open-team="openTeam"
          @takeover="takeover"
          @handback="handback"
          @resolve-runtime="resolveRuntime"
          @clear-notifications="clearNotifications"
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
