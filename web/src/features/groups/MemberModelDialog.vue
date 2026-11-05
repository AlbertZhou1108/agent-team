<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { Brain } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import PanelAgentModelSelector from '@/features/panel-agent/PanelAgentModelSelector.vue';
import type { AvailableHost, PanelAgentForm } from '@/features/panel-agent/types';
import { api } from '@/shared/api/client';
import type { Member } from '@/shared/api/raw-types';

const props = defineProps<{
  member: Member | null;
}>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{
  saved: [member: Member];
}>();

const hosts = ref<AvailableHost[]>([]);
const loading = ref(false);
const busy = ref(false);

const form = ref<PanelAgentForm>({
  name: '',
  host: '',
  model_provider: '',
  model: '',
  reasoning_effort: '',
  workspace: '',
  access: 'read-only',
});

const currentSummary = computed(() => {
  if (!props.member) return '';
  const { model_provider, model, reasoning_effort } = props.member;
  if (!model) return '宿主默认模型';
  return `${model_provider ? `${model_provider}/` : ''}${model}${reasoning_effort ? `（强度 ${reasoning_effort}）` : ''}`;
});

async function loadCatalog() {
  if (!props.member) return;
  loading.value = true;
  try {
    const catalog = await api.modelCatalog(true);
    hosts.value = catalog.hosts
      .filter((host) => host.ok && host.catalog && host.host === props.member?.host)
      .map((host) => ({ host: host.host, catalog: host.catalog! }));
    if (!hosts.value.length) toast.error('宿主模型目录不可用', { description: props.member.host });
    const host = hosts.value[0];
    const hadModel = Boolean(form.value.model);
    const model = host
      ? (host.catalog.models.find((item) => item.id === form.value.model)
        ?? host.catalog.models.find((item) => item.id === host.catalog.defaultModel)
        ?? host.catalog.models.find((item) => item.isDefault)
        ?? host.catalog.models[0])
      : undefined;
    if (host && model) {
      const efforts = model.reasoningEfforts.length ? model.reasoningEfforts : host.catalog.reasoningEfforts;
      const effortSupported = form.value.reasoning_effort && efforts.some((item) => item.id === form.value.reasoning_effort);
      Object.assign(form.value, {
        host: host.host,
        model_provider: model.provider ?? '',
        model: model.id,
        // 已有配置且强度仍受支持时保留原值，否则回退模型默认
        reasoning_effort: hadModel && effortSupported
          ? form.value.reasoning_effort
          : model.defaultReasoningEffort ?? efforts[0]?.id ?? '',
      });
    }
  } catch (error) {
    toast.error('读取模型目录失败', { description: String(error) });
  } finally {
    loading.value = false;
  }
}

watch(
  () => [open.value, props.member?.id] as const,
  ([isOpen]) => {
    if (!isOpen || !props.member) return;
    Object.assign(form.value, {
      name: props.member.name,
      host: props.member.host,
      model_provider: props.member.model_provider ?? '',
      model: props.member.model ?? '',
      reasoning_effort: props.member.reasoning_effort ?? '',
      workspace: '',
      access: 'read-only',
    });
    void loadCatalog();
  },
);

async function submit(reset: boolean) {
  if (!props.member || busy.value) return;
  // 未选模型时按钮已禁用并带原因提示,这里只做兜底拦截,不再弹 toast。
  if (!reset && !form.value.model) return;
  busy.value = true;
  try {
    const member = await api.updateMemberModel(props.member.group_id, props.member.id, reset
      ? {}
      : { model_provider: form.value.model_provider || null, model: form.value.model, reasoning_effort: form.value.reasoning_effort || null });
    toast.success(`已将 ${props.member.name} 的模型${reset ? '恢复为宿主默认' : '调整完成'}`);
    emit('saved', member);
    open.value = false;
  } catch (error) {
    toast.error('调整模型失败', { description: String(error) });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(value) => (open = value)">
    <DialogContent v-if="member" class="max-w-lg">
      <DialogHeader>
        <DialogTitle>调整模型 · {{ member.name }}</DialogTitle>
        <DialogDescription>
          当前：{{ currentSummary }}。选择新配置后立即生效，成员下一回合起使用；会话与上下文保持不变。
        </DialogDescription>
      </DialogHeader>
      <div class="flex flex-col gap-3">
        <div v-if="loading" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Brain class="size-4 animate-pulse" />
          正在读取宿主模型目录…
        </div>
        <PanelAgentModelSelector v-else v-model:form="form" :hosts="hosts" />
      </div>
      <DialogFooter class="flex-row justify-between gap-2 sm:justify-between">
        <Button variant="outline" :disabled="busy || loading" @click="submit(true)">恢复宿主默认</Button>
        <Button
          :disabled="busy || loading || !form.model"
          :title="!form.model ? '请先选择模型' : undefined"
          @click="submit(false)"
        >保存调整</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
