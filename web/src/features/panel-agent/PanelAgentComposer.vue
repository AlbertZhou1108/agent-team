<script setup lang="ts">
import { CircleStop, Settings2, ShieldCheck } from '@lucide/vue';
import MessageComposer from '@/components/ai-elements/MessageComposer.vue';
import { panelAccessOption, panelAccessOptions } from './access';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';
import type { PanelAccess } from './types';
import { InputGroupButton } from '@/components/ui/input-group';
import type { PanelAgent } from '@/shared/api/raw-types';
import PanelAgentModelSelector from './PanelAgentModelSelector.vue';
import type { AvailableHost, PanelAgentForm } from './types';
defineProps<{
  agent: PanelAgent;
  sending: boolean;
  stopping: boolean;
  hosts: AvailableHost[];
  catalogLoading: boolean;
  modelSaving: boolean;
}>();
const draft = defineModel<string>({ required: true });
const form = defineModel<PanelAgentForm>('form', { required: true });
const emit = defineEmits<{
  submit: [];
  stop: [];
  edit: [];
  updateModel: [form: PanelAgentForm];
}>();
</script>
<template>
  <MessageComposer v-model="draft" :sending="sending" label="Panel Agent 消息"
    placeholder="询问团队状态，或让 Panel Agent 准备一个新团队…" @submit="emit('submit')">
    <template #controls>
      <PanelAgentModelSelector v-model:form="form" :hosts="hosts" size="sm"
        :disabled="sending || catalogLoading || modelSaving" @change="emit('updateModel', $event)" />
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <InputGroupButton size="sm" variant="ghost" :disabled="sending || modelSaving"
            :aria-label="`访问级别：${panelAccessOption(agent.access).label}`"
            :title="`访问级别：${panelAccessOption(agent.access).label}`">
            <ShieldCheck />{{ panelAccessOption(agent.access).label }}
          </InputGroupButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup :model-value="agent.access ?? 'read-only'" @update:model-value="emit('updateModel', { ...form, access: $event as PanelAccess })">
            <DropdownMenuRadioItem v-for="option in panelAccessOptions" :key="option.value" :value="option.value"
              class="pl-2 data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground"
              :disabled="option.value !== 'read-only' && !agent.workspace" :title="option.description">
              <template #indicator-icon><span /></template>
              {{ option.label }}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <p v-if="!agent.workspace" class="max-w-64 px-2 py-1 text-xs text-muted-foreground">设置私人工作区后可启用写入权限。</p>
        </DropdownMenuContent>
      </DropdownMenu>
      <InputGroupButton size="icon-sm" variant="ghost" :disabled="sending || modelSaving"
        aria-label="Panel Agent 设置" title="Panel Agent 设置" @click="emit('edit')"><Settings2 /></InputGroupButton>
    </template>
    <template #actions>
      <InputGroupButton v-if="sending" size="sm" variant="outline" :disabled="stopping" @click="emit('stop')">
        <CircleStop data-icon="inline-start" />{{ stopping ? '停止中…' : '停止' }}
      </InputGroupButton>
    </template>
  </MessageComposer>
</template>
