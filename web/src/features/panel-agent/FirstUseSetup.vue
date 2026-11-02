<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import { api } from '@/shared/api/client';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Disclosure } from '@/components/ui/disclosure';
import { FieldGroup, Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import HostStatuses from '@/features/settings/HostStatuses.vue';
import PanelAgentModelSelector from './PanelAgentModelSelector.vue';
import type { AvailableHost, PanelAgentForm } from './types';

const emit = defineEmits<{ created: [] }>();
const hosts = ref<AvailableHost[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
let selection = 0;
const form = ref<PanelAgentForm>({ name: '私人助手', host: '', model_provider: '', model: '', reasoning_effort: '', workspace: '', access: 'read-only' });
const draftKey = 'agent-team:first-use';
watch(form, value => { try { sessionStorage.setItem(draftKey, JSON.stringify(value)); } catch { /* Keep memory state. */ } }, { deep: true });
onMounted(async () => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
    if (!saved || typeof saved.host !== 'string' || !saved.host) return;
    await selectHost(saved.host);
    if (hosts.value[0]?.catalog.models.some(item => item.id === saved.model && (!saved.model_provider || item.provider === saved.model_provider))) {
      form.value = { ...form.value, name: typeof saved.name === 'string' ? saved.name : form.value.name, model: saved.model, model_provider: saved.model_provider || '', reasoning_effort: saved.reasoning_effort || '' };
    }
  } catch { /* An unreadable draft does not block first use. */ }
});
const selectedModel = computed(() => hosts.value[0]?.catalog.models.find(item => item.id === form.value.model && (!form.value.model_provider || item.provider === form.value.model_provider)));
const canSave = computed(() => Boolean(form.value.name.trim() && selectedModel.value) && !loading.value && !saving.value);

async function selectHost(host: string) {
  const request = ++selection;
  loading.value = true; error.value = ''; hosts.value = [];
  form.value = { ...form.value, host, model: '', model_provider: '', reasoning_effort: '' };
  try {
    const response = await api.modelCatalog(false, undefined, host);
    if (request !== selection) return;
    const entry = response.hosts.find(item => item.host === host);
    if (!entry?.ok || !entry.catalog || !entry.catalog.models.length) throw new Error(entry?.error || '无法读取此工具的模型目录，请在宿主中检查配置后重试。');
    hosts.value = [{ host, catalog: entry.catalog }];
    const model = entry.catalog.models.find(item => item.key === entry.catalog!.defaultModel) ?? entry.catalog.models.find(item => item.isDefault);
    if (model) form.value = { ...form.value, model: model.id, model_provider: model.provider ?? '', reasoning_effort: model.defaultReasoningEffort ?? '' };
  } catch (cause) { if (request === selection) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { if (request === selection) loading.value = false; }
}

async function save() {
  if (!canSave.value) return;
  saving.value = true; error.value = '';
  try {
    await api.createPanelAgent({ ...form.value, workspace: null, model_provider: form.value.model_provider || null });
    try { sessionStorage.removeItem(draftKey); } catch { /* Configuration is already saved. */ }
    emit('created');
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { saving.value = false; }
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
    <Card>
      <CardHeader>
        <CardTitle>开始使用 Agent Team</CardTitle>
        <CardDescription>选择一个 AI 工具，开始与私人助手聊天。需要多人协作时，再创建团队。</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <HostStatuses :active="true" :selectable="!saving" @select="selectHost" />
        <p v-if="loading" role="status">正在准备所选工具…</p>
        <div v-if="hosts.length" class="flex flex-col gap-3">
          <p>{{ selectedModel ? `已选择 ${form.host} · ${selectedModel.label}` : '此工具没有明确的默认模型，请选择。' }}</p>
          <PanelAgentModelSelector v-if="!selectedModel" v-model:form="form" :hosts="hosts" :disabled="saving" />
          <Disclosure>
            <template #summary>调整模型与名称</template>
            <FieldGroup>
              <Field><FieldLabel for="first-assistant-name">助手名称</FieldLabel><Input id="first-assistant-name" v-model="form.name" :disabled="saving" maxlength="100" /></Field>
              <Field><FieldLabel>模型配置</FieldLabel><PanelAgentModelSelector v-model:form="form" :hosts="hosts" :disabled="saving" /></Field>
            </FieldGroup>
          </Disclosure>
        </div>
        <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}<Button v-if="form.host && !hosts.length" variant="outline" size="sm" :disabled="loading" @click="selectHost(form.host)">重试</Button></AlertDescription></Alert>
      </CardContent>
      <CardFooter class="flex flex-wrap gap-3">
        <Button :disabled="!canSave" @click="save">{{ saving ? '准备中…' : '开始聊天' }}</Button>
        <Button as-child variant="ghost"><RouterLink to="/groups">先看看工作台</RouterLink></Button>
      </CardFooter>
    </Card>
    <p class="text-sm text-muted-foreground">助手初始为只读，需要处理本地文件时再选择目录和权限。登录、模型配置和额度由对应 AI 工具管理。</p>
  </div>
</template>
