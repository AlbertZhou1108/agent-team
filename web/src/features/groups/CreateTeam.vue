<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { api, ApiError } from '@/shared/api/client';
import type { Group } from '@/shared/api/raw-types';
import { invalidateWorkspaceResources } from '@/features/query-keys';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { FieldGroup, Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from '@/components/ui/select';
import HostStatuses from '@/features/settings/HostStatuses.vue';

const router = useRouter(), client = useQueryClient();
const key = 'agent-team:create-team-draft';
const initial = () => ({ operationId: crypto.randomUUID(), name: '', text: '', workspace: '', host: '', worker: '协作助手', policy: 'read-only', submitted: false, group: null as Group | null });
function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (saved && typeof saved.operationId === 'string') return { ...initial(), ...saved };
  } catch { /* Storage may be unavailable. */ }
  return initial();
}
const form = ref(restore());
const busy = ref(false), picking = ref(false), error = ref('');
watch(form, value => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep the in-memory draft. */ } }, { deep: true });
const canCreate = computed(() => form.value.group || (form.value.name.trim() && form.value.text.trim() && form.value.workspace && form.value.host));
async function chooseDirectory() {
  if (picking.value) return;
  picking.value = true;
  try { const result = await api.chooseDirectory(); if (result.path) form.value.workspace = result.path; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { picking.value = false; }
}
async function submit() {
  if (busy.value || picking.value || !canCreate.value) return;
  if (!form.value.group && form.value.worker.trim() === '主 Agent') { error.value = '协作助手名称不能与主 Agent 重复'; return; }
  form.value.submitted = true;
  busy.value = true; error.value = '';
  try {
    if (!form.value.group) form.value.group = await api.createGroup({ operationId: form.value.operationId, name: form.value.name.trim(), workspace: form.value.workspace, lead: { name: '主 Agent', host: form.value.host }, members: form.value.worker.trim() ? [{ name: form.value.worker.trim(), host: form.value.host }] : [], policy: form.value.policy });
    const group = form.value.group!;
    if (!group.lead) throw new Error('团队没有可用的主 Agent');
    await api.sendTeamDirective(group.id, { operationId: `${form.value.operationId}-first`, text: form.value.text.trim(), controllerId: group.lead });
    await invalidateWorkspaceResources(client);
    try { sessionStorage.removeItem(key); } catch { /* Submission already succeeded. */ }
    await router.push({ name: 'group', params: { groupId: group.id } });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    if (!form.value.group && cause instanceof ApiError && cause.status === 400) form.value.submitted = false;
  }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="mx-auto w-full max-w-2xl p-4">
    <Card>
      <CardHeader><CardTitle>创建团队</CardTitle><CardDescription>说明要完成什么，由主 Agent 协调、协作助手参与。创建成员会调用模型进行能力自述，产生正常调用消耗。</CardDescription></CardHeader>
      <form @submit.prevent="submit">
        <CardContent class="flex flex-col gap-4">
          <FieldGroup :disabled="busy || form.submitted">
            <Field><FieldLabel for="team-name">团队名称</FieldLabel><Input id="team-name" v-model="form.name" :disabled="busy || form.submitted" required maxlength="200" /></Field>
            <Field><FieldLabel for="team-request">要完成什么？</FieldLabel><Textarea id="team-request" v-model="form.text" :disabled="busy || form.submitted" required maxlength="48000" placeholder="描述需求、使用材料和希望得到的结果" /></Field>
            <Field><FieldLabel>使用哪个 AI 工具？</FieldLabel><p v-if="form.host">已选择：{{ form.host }}</p><HostStatuses v-if="!form.group" :active="true" :selectable="!busy" @select="form.host = $event" /></Field>
            <Field><FieldLabel for="team-worker">协作助手名称</FieldLabel><Input id="team-worker" v-model="form.worker" :disabled="busy || form.submitted" maxlength="100" /><FieldDescription>主 Agent 负责协调与汇总；此成员按消息参与协作。留空则只创建主 Agent。</FieldDescription></Field>
            <Field><FieldLabel for="team-directory">工作文件夹</FieldLabel><div class="flex gap-2"><Input id="team-directory" v-model="form.workspace" :disabled="busy || form.submitted" placeholder="选择文件夹或粘贴路径" /><Button type="button" variant="outline" :disabled="busy || picking || form.submitted" @click="chooseDirectory">选择</Button></div></Field>
            <Field><FieldLabel>文件访问范围</FieldLabel><Select v-model="form.policy" :disabled="busy || form.submitted"><SelectTrigger aria-label="文件访问范围"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="communication">仅沟通</SelectItem><SelectItem value="read-only">只读</SelectItem><SelectItem value="workspace-write">允许修改工作文件夹</SelectItem></SelectGroup></SelectContent></Select><FieldDescription>团队说明和聊天中的确认不会改变此权限。</FieldDescription></Field>
          </FieldGroup>
          <p v-if="form.submitted && !form.group && !busy" class="text-sm text-muted-foreground">创建结果尚未确认，请重试同一请求以找回结果。</p>
          <Alert v-if="form.group"><AlertDescription>团队已创建。需求发送未确认时，再次提交会使用同一请求重试，不会重新建群。<RouterLink :to="`/groups/${form.group.id}`">进入团队</RouterLink></AlertDescription></Alert>
          <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>
        </CardContent>
        <CardFooter class="flex gap-3"><Button type="submit" :disabled="busy || picking || !canCreate">{{ busy ? '提交中…' : form.group ? '重试发送需求' : '创建并发送需求' }}</Button><Button as-child variant="ghost"><RouterLink to="/groups">返回工作台</RouterLink></Button></CardFooter>
      </form>
    </Card>
  </div>
</template>
