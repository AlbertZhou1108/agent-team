<script setup lang="ts">
import { computed } from 'vue';
import {
  Bot,
  Eye,
  LoaderCircle,
  Radio,
  ShieldCheck,
  Users,
} from '@lucide/vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
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
import type {
  AvailableHost,
  PanelAgentForm,
} from './types';

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

const canSave = computed(() => (
  Boolean(
    form.value.name.trim()
    && form.value.host
    && form.value.model
    && form.value.reasoning_effort,
  )
  && !props.catalogLoading
  && !props.saving
));

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
    <section class="panel agent-create-card">
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
          <p class="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            一个 Agent 同时承担全局私人会话与获准后的团队主控，按需观察或操作多个团队。
          </p>
        </div>
      </header>

      <div v-if="catalogLoading" class="agent-catalog-state">
        <LoaderCircle class="animate-spin" />
        正在读取可用宿主与模型…
      </div>
      <div v-else-if="catalogError" class="error-banner mt-5" role="alert">
        <span class="min-w-0 flex-1">{{ catalogError }}</span>
        <Button variant="outline" size="sm" @click="emit('retry')">重试</Button>
      </div>
      <form v-else class="mt-6" @submit.prevent="emit('save')">
        <FieldGroup class="gap-5">
          <Field class="gap-2">
            <FieldLabel for="panel-agent-name">名称</FieldLabel>
            <Input
              id="panel-agent-name"
              v-model="form.name"
              maxlength="100"
              autocomplete="off"
              placeholder="Panel Agent"
            />
            <FieldDescription>
              该名称用于私人会话和团队主控中的统一身份。
            </FieldDescription>
          </Field>

          <Field class="gap-2">
            <FieldLabel>宿主、模型与思考强度</FieldLabel>
            <PanelAgentModelSelector
              v-model:form="form"
              :hosts="hosts"
              :disabled="saving"
            />
            <FieldDescription>
              团队创建和主控回合都使用这一套模型配置。
            </FieldDescription>
          </Field>

          <p v-if="actionError" class="error-banner" role="alert">{{ actionError }}</p>
          <div class="flex flex-wrap gap-2">
            <Button type="submit" :disabled="!canSave">
              <LoaderCircle v-if="saving" data-icon="inline-start" class="animate-spin" />
              {{ saving ? '保存中…' : agent ? '保存设置' : '创建 Panel Agent' }}
            </Button>
            <Button v-if="agent" type="button" variant="ghost" @click="emit('cancel')">
              取消
            </Button>
          </div>
        </FieldGroup>
      </form>
    </section>

    <aside class="panel agent-principles">
      <h2 class="text-sm font-semibold">运行边界</h2>
      <ItemGroup class="mt-4 gap-2">
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
            <ItemTitle class="text-xs leading-5">{{ principle.text }}</ItemTitle>
          </ItemContent>
        </Item>
      </ItemGroup>
    </aside>
  </div>
</template>
