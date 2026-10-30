<script setup lang="ts">
import HelpPopover from '@/components/panel/HelpPopover.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { computed, ref } from 'vue';
import { api } from '@/shared/api/client';
import { Bot, Eye, FolderOpen, LoaderCircle, Radio, ShieldCheck, Users } from '@lucide/vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';

import type { PanelAgent } from '@/shared/api/raw-types';
import PanelAgentModelSelector from './PanelAgentModelSelector.vue';
import type { AvailableHost, PanelAgentForm } from './types';

const props = defineProps<{
  agent: PanelAgent | null;
  hosts: AvailableHost[];
  catalogLoading: boolean;
  catalogError: string;
  actionError: string;
  saving: boolean;
}>();
const form = defineModel<PanelAgentForm>('form', { required: true });
const emit = defineEmits<{
  save: [];
  cancel: [];
  retry: [];
}>();

const pickingDirectory = ref(false);
const directoryError = ref('');
async function pickDirectory() {
  pickingDirectory.value = true;
  directoryError.value = '';
  try {
    const result = await api.chooseDirectory();
    if (result.path) form.value.workspace = result.path;
  } catch (error) { directoryError.value = error instanceof Error ? error.message : String(error); }
  finally { pickingDirectory.value = false; }
}

const workspaceRequired = computed(() => form.value.access !== 'read-only');
const workspaceMissing = computed(
  () => workspaceRequired.value && !form.value.workspace.trim(),
);


const canSave = computed(
  () =>
    Boolean(
      form.value.name.trim() &&
        form.value.host &&
        form.value.model &&
        form.value.reasoning_effort,
    ) &&
    !workspaceMissing.value &&
    !props.catalogLoading &&
    !props.saving,
);

const principles = [
  { icon: Eye, text: '自动观察当前数据目录的全部团队共享记录' },
  { icon: ShieldCheck, text: '观察状态不能写入团队消息或工作项' },
  { icon: Radio, text: '只有用户确认后才能接管团队' },
  { icon: Users, text: 'Panel Agent 不进入普通成员列表' },
  { icon: Bot, text: '私人会话和团队主控共享同一套模型配置' },
];
</script>

<template>
  <div class="agent-create-layout">
    <Card class="panel agent-create-card">
      <CardContent>
        <header class="flex items-start gap-4">
          <div class="agent-mark">
            <Bot />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="eyebrow">LOCAL PANEL AGENT</p>
              <Badge variant="default">全局单例</Badge>
            </div>
            <h1 class="mt-2 text-2xl font-semibold">
              {{ agent ? '编辑 Panel Agent' : '创建 Panel Agent' }}
            </h1>
            <p v-if="!agent" class="mt-2 text-sm text-muted-foreground">配置私人助手，按需参与团队协作。</p>
          </div>
        </header>

        <div v-if="catalogLoading" class="agent-catalog-state">
          <LoaderCircle class="animate-spin" />
          正在读取可用宿主与模型…
        </div>
        <Alert
          variant="destructive"
          v-else-if="catalogError"
          class="error-banner mt-5"
          role="alert"
          ><AlertDescription class="flex items-center gap-2">
            <span class="min-w-0 flex-1">{{ catalogError }}</span>
            <Button variant="outline" size="sm" @click="emit('retry')"
              >重试</Button
            >
          </AlertDescription></Alert
        >
        <form v-else class="mt-6" @submit.prevent="emit('save')">
          <FieldGroup>
            <Field>
              <FieldLabel for="panel-agent-name">名称</FieldLabel>
              <Input
                id="panel-agent-name"
                v-model="form.name"
                maxlength="100"
                autocomplete="off"
                placeholder="Panel Agent"
              />
            </Field>

            <Field>
              <div class="flex items-center gap-1"><FieldLabel>宿主、模型与思考强度</FieldLabel><HelpPopover title="模型配置"><p>团队创建和主控回合共用此配置。</p></HelpPopover></div>
              <PanelAgentModelSelector
                v-model:form="form"
                :hosts="hosts"
                :disabled="saving"
              />
            </Field>

            <Field :data-invalid="workspaceMissing || undefined">
              <FieldLabel for="panel-agent-workspace">私人工作区</FieldLabel>
              <div class="flex min-w-0 items-center gap-2">
                <Input id="panel-agent-workspace" :model-value="form.workspace" readonly
                  class="min-w-0 flex-1" placeholder="尚未选择文件夹" :title="form.workspace"
                  :aria-invalid="workspaceMissing || undefined" />
                <Button type="button" variant="outline" :disabled="saving || catalogLoading || pickingDirectory" @click="pickDirectory">
                  <LoaderCircle v-if="pickingDirectory" class="animate-spin" />
                  <FolderOpen v-else />{{ pickingDirectory ? '选择中…' : '选择文件夹' }}
                </Button>
                <Button v-if="form.workspace" type="button" variant="ghost" :disabled="saving || pickingDirectory" @click="form.workspace = ''">清除</Button>
              </div>
              <FieldError v-if="directoryError">{{ directoryError }}</FieldError>
              <FieldDescription>
                Panel Agent 私人会话的命令工作目录，与团队项目目录独立。留空时使用应用数据目录；选择工作区写入或完全权限时必须填写。
              </FieldDescription>
              <FieldError v-if="workspaceMissing">
                选择“工作区写入”或“完全权限”时，请选择私人工作区文件夹。
              </FieldError>
            </Field>

            <p v-if="actionError" class="error-banner" role="alert">
              {{ actionError }}
            </p>
            <div class="flex flex-wrap gap-2">
              <Button type="submit" :disabled="!canSave">
                <LoaderCircle
                  v-if="saving"
                  data-icon="inline-start"
                  class="animate-spin"
                />
                {{
                  saving ? '保存中…' : agent ? '保存设置' : '创建 Panel Agent'
                }}
              </Button>
              <Button
                v-if="agent"
                type="button"
                variant="ghost"
                @click="emit('cancel')"
              >
                取消
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>

    <Card class="panel agent-principles">
      <CardContent>
        <h2 class="text-sm font-semibold">运行边界</h2>
        <ItemGroup class="mt-4">
          <Item
            v-for="principle in principles"
            :key="principle.text"
            variant="muted"
            size="sm"
            class="items-start"
          >
            <ItemMedia variant="icon">
              <component :is="principle.icon" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{{ principle.text }}</ItemTitle>
            </ItemContent>
          </Item>
        </ItemGroup>
      </CardContent>
    </Card>
  </div>
</template>
