<script setup lang="ts">
import LocalService from '../LocalService.vue';
import AttachmentSettings from '../AttachmentSettings.vue';
import HelpPopover from '@/components/panel/HelpPopover.vue';
import { Switch } from '@/components/ui/switch';
import { usePreferencesStore } from '@/stores/preferences';
import HostIntegrationPanel from '../hosts/HostIntegrationPanel.vue';
import type { HostKind } from '../hosts/host-view-model';

const preferences = usePreferencesStore();
const emit = defineEmits<{ 'open-host-detail': [kind: HostKind] }>();
</script>

<template>
  <HostIntegrationPanel active @open-detail="emit('open-host-detail', $event)" />

  <LocalService />

          <section class="flex flex-col gap-3">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-1"><h3 class="text-sm font-semibold">思考过程</h3><HelpPopover title="思考过程"><p>在会话和消息流中显示模型的实时思考与“宿主思考”步骤。</p></HelpPopover></div>
              </div>
              <Switch
                :model-value="preferences.showReasoning"
                class="shrink-0"
                aria-label="显示思考过程"
                @update:model-value="preferences.setShowReasoning(Boolean($event))"
              />
            </div>
          </section>

          <section class="flex flex-col gap-3">
            <AttachmentSettings />
          </section>
</template>
