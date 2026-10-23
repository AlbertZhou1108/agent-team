<script setup lang="ts">
import { computed } from 'vue';
import { Bot, Brain, Check, ChevronDown } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ButtonVariants } from '@/components/ui/button';
import type { CatalogModel } from '@/shared/api/raw-types';
import type { AvailableHost, PanelAgentForm } from './types';

const props = withDefaults(
  defineProps<{
    hosts: AvailableHost[];
    disabled?: boolean;
    size?: ButtonVariants['size'];
  }>(),
  {
    disabled: false,
    size: 'default',
  },
);
const form = defineModel<PanelAgentForm>('form', { required: true });
const emit = defineEmits<{
  change: [form: PanelAgentForm];
}>();

const selectedHost = computed(() =>
  props.hosts.find((host) => host.host === form.value.host),
);
const selectedModel = computed(() =>
  selectedHost.value?.catalog.models.find(
    (model) => model.id === form.value.model,
  ),
);
const efforts = computed(() =>
  selectedModel.value?.reasoningEfforts.length
    ? selectedModel.value.reasoningEfforts
    : (selectedHost.value?.catalog.reasoningEfforts ?? []),
);

function selectModel(host: AvailableHost, model: CatalogModel) {
  const effortsForModel = model.reasoningEfforts.length
    ? model.reasoningEfforts
    : host.catalog.reasoningEfforts;
  const next = {
    ...form.value,
    host: host.host,
    model_provider: model.provider ?? '',
    model: model.id,
    reasoning_effort:
      model.defaultReasoningEffort ?? effortsForModel[0]?.id ?? '',
  };
  form.value = next;
  emit('change', next);
}

function selectEffort(effort: string) {
  if (effort === form.value.reasoning_effort) return;
  const next = { ...form.value, reasoning_effort: effort };
  form.value = next;
  emit('change', next);
}
</script>

<template>
  <div class="flex min-w-0 flex-wrap gap-2">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          variant="outline"
          :size="size"
          :disabled="disabled"
          class="min-w-0 justify-start"
          :aria-label="`模型：${selectedModel?.label ?? (form.model || '未选择')}`"
        >
          <Bot data-icon="inline-start" />
          <span class="truncate">{{ selectedModel?.label ?? (form.model || '选择模型') }}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="max-h-80 w-72 overflow-y-auto">
        <template v-for="(host, index) in hosts" :key="host.host">
          <DropdownMenuSeparator v-if="index > 0" />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{{ host.host }}</DropdownMenuLabel>
            <DropdownMenuItem
              v-for="model in host.catalog.models"
              :key="`${host.host}:${model.key}`"
              @select="selectModel(host, model)"
            >
              <span class="min-w-0 flex-1 truncate">{{ model.label }}</span>
              <Check
                v-if="form.host === host.host && form.model === model.id"
              />
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          variant="outline"
          :size="size"
          :disabled="disabled || !efforts.length"
          class="justify-start"
          :aria-label="`思考强度：${form.reasoning_effort || '未选择'}`"
        >
          <Brain data-icon="inline-start" />
          {{ form.reasoning_effort || '思考强度' }}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>思考强度</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            :model-value="form.reasoning_effort"
            @update:model-value="(value) => selectEffort(String(value))"
          >
            <DropdownMenuRadioItem
              v-for="effort in efforts"
              :key="effort.id"
              :value="effort.id"
            >
              {{ effort.label }}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
