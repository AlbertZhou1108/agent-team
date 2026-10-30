<script setup lang="ts">
import { computed, ref } from 'vue';
import { Bot, Brain, Check, ChevronLeft, ChevronRight, Cpu } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
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

const open = ref(false);
const view = ref<'panel' | 'provider'>('panel');
// 记住已提交档位,避免拖动过程中重复提交同一档。
const committedEffort = ref<string | null>(null);

const hostLabels: Record<string, string> = { dsh: 'DeepSeek', claude: 'Claude', codex: 'Codex' };
const hostLabel = (host: string) => hostLabels[host] ?? host;

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
const effortLabels: Record<string, string> = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  ultra: '极高',
};
const effortLabel = (id?: string | null) =>
  id ? (effortLabels[id] ?? id) : '默认';
const effortIndex = computed(() => {
  const index = efforts.value.findIndex((item) => item.id === form.value.reasoning_effort);
  if (index >= 0) return index;
  const fallback = efforts.value.findIndex(
    (item) => item.id === (selectedModel.value?.defaultReasoningEffort ?? ''),
  );
  return Math.max(0, fallback);
});
const canSlide = computed(() => efforts.value.length > 1 && !props.disabled);

function commit(next: PanelAgentForm) {
  form.value = next;
  emit('change', next);
}

function selectModel(host: AvailableHost, model: CatalogModel) {
  const effortsForModel = model.reasoningEfforts.length
    ? model.reasoningEfforts
    : host.catalog.reasoningEfforts;
  commit({
    ...form.value,
    host: host.host,
    model_provider: model.provider ?? '',
    model: model.id,
    reasoning_effort:
      model.defaultReasoningEffort ?? effortsForModel[0]?.id ?? '',
  });
  open.value = false;
  view.value = 'panel';
}

function chooseHost(host: AvailableHost) {
  const model =
    host.catalog.models.find((item) => item.id === host.catalog.defaultModel) ??
    host.catalog.models.find((item) => item.isDefault) ??
    host.catalog.models[0];
  if (model) selectModel(host, model);
}

// 拖动过程只更新本地预览(档位标签实时跟随),松手由 valueCommit 提交一次;
// reka 的键盘操作(Home/End/方向键)同样以 commit:true 走 valueCommit。
function previewEffort(value: number | readonly number[] | undefined) {
  const index = Array.isArray(value) ? value[0] : value;
  const effort = typeof index === 'number' ? efforts.value[index] : undefined;
  if (!effort) return;
  form.value = { ...form.value, reasoning_effort: effort.id };
}

function commitEffort(value: number | readonly number[] | undefined) {
  const index = Array.isArray(value) ? value[0] : value;
  const effort = typeof index === 'number' ? efforts.value[index] : undefined;
  // preview 已把 form 改成目标档位,这里只需去重:同一档位不重复请求。
  if (!effort || effort.id === committedEffort.value) return;
  committedEffort.value = effort.id;
  commit({ ...form.value, reasoning_effort: effort.id });
}

function setOpen(value: boolean) {
  open.value = value;
  if (!value) view.value = 'panel';
  committedEffort.value = form.value.reasoning_effort ?? null;
}

function modalityLabel(model: CatalogModel) {
  return model.inputModalities?.includes('image') ? '视觉' : null;
}
</script>

<template>
  <Popover :open="open" @update:open="setOpen">
    <PopoverTrigger as-child>
      <Button
        variant="outline"
        :size="size"
        :disabled="disabled"
        class="min-w-0 shrink justify-start"
        :aria-label="`模型：${selectedModel?.label ?? (form.model || '未选择')}`"
      >
        <Bot data-icon="inline-start" />
        <span class="truncate">{{ selectedModel?.label ?? (form.model || '选择模型') }}</span>
        <ChevronRight data-icon="inline-end" class="text-muted-foreground" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-80 p-0">
      <!-- 主面板:供应商 / 模型 / 思考强度 -->
      <template v-if="view === 'panel'">
        <button
          type="button"
          class="flex w-full items-center gap-2 border-b px-3 py-3 text-left hover:bg-accent"
          :disabled="hosts.length <= 1"
          @click="view = 'provider'"
        >
          <Cpu class="text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate text-sm font-medium">
            {{ hostLabel(form.host) }}
          </span>
          <Badge variant="outline">API</Badge>
          <ChevronRight class="text-muted-foreground" />
        </button>

        <div class="border-b px-3 py-3">
          <p class="mb-2 text-xs text-muted-foreground">模型</p>
          <div class="scrollbar-thin flex max-h-56 flex-col gap-0.5 overflow-y-auto">
            <button
              v-for="model in selectedHost?.catalog.models ?? []"
              :key="model.key"
              type="button"
              class="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent"
              @click="selectedHost && selectModel(selectedHost, model)"
            >
              <span class="min-w-0 flex-1 truncate">{{ model.label }}</span>
              <Badge v-if="modalityLabel(model)" variant="outline">{{ modalityLabel(model) }}</Badge>
              <Check v-if="form.model === model.id" class="shrink-0 text-muted-foreground" />
            </button>
            <p v-if="!selectedHost" class="px-1 py-2 text-xs text-muted-foreground">
              模型目录尚未加载。
            </p>
          </div>
        </div>

        <div class="px-3 py-3">
          <div class="mb-3 flex items-center gap-2">
            <Brain class="text-muted-foreground" />
            <span class="text-xs text-muted-foreground">思考强度</span>
            <span class="text-sm font-medium">{{ effortLabel(form.reasoning_effort) }}</span>
          </div>
          <Slider
            class="model-effort-slider"
            :model-value="[effortIndex]"
            :min="0"
            :max="Math.max(0, efforts.length - 1)"
            :step="1"
            :disabled="!canSlide"
            aria-label="思考强度"
            @update:model-value="previewEffort"
            @value-commit="commitEffort"
          />
          <div class="mt-2 flex justify-between text-[10px] text-muted-foreground">
            <span>{{ efforts[0] ? effortLabel(efforts[0].id) : '' }}</span>
            <span>{{ efforts.at(-1) ? effortLabel(efforts.at(-1)!.id) : '' }}</span>
          </div>
        </div>
      </template>

      <!-- 供应商二级菜单 -->
      <template v-else>
        <button
          type="button"
          class="flex w-full items-center gap-2 border-b px-3 py-3 text-left hover:bg-accent"
          @click="view = 'panel'"
        >
          <ChevronLeft class="text-muted-foreground" />
          <span class="text-sm font-medium">选择供应商</span>
        </button>
        <div class="flex flex-col gap-0.5 p-2">
          <button
            v-for="host in hosts"
            :key="host.host"
            type="button"
            class="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent"
            @click="chooseHost(host)"
          >
            <span class="min-w-0 flex-1 truncate">{{ hostLabel(host.host) }}</span>
            <Badge variant="outline">API</Badge>
            <Check v-if="form.host === host.host" class="shrink-0 text-muted-foreground" />
          </button>
          <p v-if="!hosts.length" class="px-2 py-2 text-xs text-muted-foreground">
            没有可用供应商。
          </p>
        </div>
      </template>
    </PopoverContent>
  </Popover>
</template>
