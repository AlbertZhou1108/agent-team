<script setup lang="ts">
import { ref, watch } from 'vue';
import PanelAgentModelSelector from '@/features/panel-agent/PanelAgentModelSelector.vue';
import type { AvailableHost, PanelAgentForm } from '@/features/panel-agent/types';

/**
 * 建群成员行的模型与思考强度选择器包装:
 * 把成员行扁平字段(host/model_provider/model/reasoning_effort)适配成
 * PanelAgentModelSelector 需要的 PanelAgentForm,避免在每行重复拼装表单对象。
 * 未显式选择模型时按钮展示「宿主默认」,提交时由 create-team-model 省略 selection。
 */
const props = withDefaults(
  defineProps<{
    hosts: AvailableHost[];
    host: string;
    modelProvider: string;
    model: string;
    reasoningEffort: string;
    disabled?: boolean;
  }>(),
  { disabled: false },
);

const emit = defineEmits<{
  change: [value: { host: string; model_provider: string; model: string; reasoning_effort: string }];
}>();

function currentForm(): PanelAgentForm {
  return {
    name: '',
    host: props.host,
    model_provider: props.modelProvider,
    model: props.model,
    reasoning_effort: props.reasoningEffort,
    workspace: '',
    access: 'read-only',
  };
}

const form = ref<PanelAgentForm>(currentForm());

watch(
  () => [props.host, props.modelProvider, props.model, props.reasoningEffort] as const,
  () => { form.value = currentForm(); },
);

function update(next: PanelAgentForm) {
  form.value = next;
}

function change(next: PanelAgentForm) {
  form.value = next;
  emit('change', {
    host: next.host,
    model_provider: next.model_provider,
    model: next.model,
    reasoning_effort: next.reasoning_effort,
  });
}
</script>

<template>
  <PanelAgentModelSelector
    :hosts="hosts"
    :disabled="disabled"
    :form="form"
    empty-label="宿主默认"
    @update:form="update"
    @change="change"
  />
</template>
