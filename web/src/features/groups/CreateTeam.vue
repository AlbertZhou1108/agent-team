<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { Trash2 } from '@lucide/vue';
import { api, ApiError } from '@/shared/api/client';
import { invalidateWorkspaceResources, queryKeys } from '@/features/query-keys';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { FieldGroup, Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { NoteBlock } from '@/components/ui/note-block';
import { SectionBlock } from '@/components/panel';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import HostStatuses from '@/features/settings/HostStatuses.vue';
import { hostDisplayLabel } from '@/features/settings/hosts/host-view-model';
import type { AvailableHost } from '@/features/panel-agent/types';
import { prefersReducedMotion } from '@/shared/motion';
import { policyLabel } from './team-summary';
import MemberModelField from './MemberModelField.vue';
import {
  POLICY_MODES,
  activeRows,
  browserRestrictedReason,
  buildCreateGroupBody,
  buildMemberSummaries,
  clampPolicyCeiling,
  effectivePolicy,
  modelLabel,
  newDraftMember,
  policyCeilingOptions,
  presetMembers,
  resolveMemberHost,
  restoreDraft,
  unknownModelMemberNames,
} from './create-team-model';
import type { WorkflowTemplate } from '@/shared/api/raw-types';
import type { DraftMember, DraftState, PresetKind } from './create-team-model';
import {
  membersFromWorkflowTemplate,
  worktreeRestrictedReason,
} from './create-team-model';

const router = useRouter();
const client = useQueryClient();
const STORAGE_KEY = 'agent-team:create-team-draft';
const INHERIT = '__inherit__';
const NO_TEMPLATE = '__none__';

const FALLBACK_WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'standard-dev',
    name: '标准完整档研发（规划 → 实现 → 独立验收）',
    summary: '主 Agent 规划调度，研发在独立 git worktree 并发编码，验收只读复核；大文档写文件传路径。',
    charter: [
      '【研发协作规范 · 标准完整档】',
      '1. 参考节奏：先澄清需求并经 ask 拍板关键取舍 → 用 tasks_set 公布切片 → 研发成员在各自工作区/worktree 编码并本地验证 → 独立验收成员只读复核 → 主 Agent 汇总结果待用户确认提交。',
      '2. 大文档路径交付：禁止在 send/note 正文粘贴长篇方案或整文件源码；Spec、设计评审与验证报告须写入工作区内 .md 文件（如 docs/flows/<topic>/spec.md、verify.md），群消息仅发送「核心结论 + 文件路径 + 关键章节锚点/验收清单」。',
      '3. Worktree 并行约定：使用独立 worktree 的研发成员完成修改并自测后，在分支提交变更并在汇报中注明分支名、修改文件与实测命令结果，避免并行覆盖。',
    ].join('\n'),
    presetMembers: [
      { name: '研发', roleHint: '编码实现与自测', policyCeiling: 'workspace-write', allowShell: true, allowBrowser: false, workspaceMode: 'worktree' },
      { name: '只读验收', roleHint: '只读与浏览器独立验收', preferredHost: 'codex', policyCeiling: 'read-only', allowShell: true, allowBrowser: true, workspaceMode: 'inherit' },
    ],
  },
  {
    id: 'quick-fix',
    name: '轻量修复直通（定位 → 修复 → 回归）',
    summary: '主 Agent 直接派发研发定位修复与回归验证，附修改文件路径与实测结果，不展开冗余文档。',
    charter: [
      '【研发协作规范 · 轻量修复】',
      '1. 聚焦最小复现与最小改动范围，不展开冗余设计文档；如中途发现需扩展交互或架构边界，及时上报调整。',
      '2. 完成修改后实跑相关测试/门禁，并在 send 回报中列出改动文件路径、实际执行的验证命令与输出摘要；长报告写文件传路径。',
    ].join('\n'),
    presetMembers: [
      { name: '研发', roleHint: '定位缺陷、修复与回归验证', policyCeiling: 'workspace-write', allowShell: true, allowBrowser: false, workspaceMode: 'inherit' },
    ],
  },
];

function readSavedDraft(): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    // sessionStorage 不可用时退回空白草稿。
    return null;
  }
}

const restored = restoreDraft(readSavedDraft());
const form = ref<DraftState>({ ...restored.draft, submitted: restored.submitted, group: restored.group });
const busy = ref(false);
const picking = ref(false);
const error = ref('');
const policyNotice = ref('');
// 建群前的确认步骤:成员矩阵、权限与工作目录先给用户看一眼。
const confirming = ref(false);
const confirmCard = ref<InstanceType<typeof NoteBlock> | null>(null);

// 实时模型目录:只读,用于成员行的模型/思考强度选择与确认卡标签;目录不可用时允许不选模型建群。
const modelCatalog = useQuery({
  queryKey: queryKeys.modelCatalog,
  queryFn: () => api.modelCatalog(false),
  staleTime: 60_000,
});
const catalogHosts = computed<AvailableHost[]>(() =>
  (modelCatalog.data.value?.hosts ?? [])
    .filter((item) => item.ok && item.catalog)
    .map((item) => ({ host: item.host, catalog: item.catalog! })),
);

const hostStatuses = useQuery({
  queryKey: ['host-statuses'],
  queryFn: () => api.probeHosts(),
  staleTime: 30_000,
});
const workflowTemplatesQuery = useQuery({
  queryKey: ['workflow-templates'],
  queryFn: async () => (await api.workflowTemplates?.()) ?? FALLBACK_WORKFLOW_TEMPLATES,
  staleTime: 60_000,
});
const workflowTemplates = computed<WorkflowTemplate[]>(() =>
  workflowTemplatesQuery.data.value?.length ? workflowTemplatesQuery.data.value : FALLBACK_WORKFLOW_TEMPLATES,
);
const selectedTemplate = computed<WorkflowTemplate | null>(
  () => workflowTemplates.value.find((item) => item.id === form.value.workflowTemplate) ?? null,
);
const lastTemplateCharter = ref('');
const charterNotice = ref('');
const hostChoices = computed<string[]>(() => {
  const names = new Set<string>();
  for (const status of hostStatuses.data.value ?? []) {
    if (status.status === 'available') names.add(status.name);
  }
  for (const item of catalogHosts.value) names.add(item.host);
  if (form.value.host) names.add(form.value.host);
  for (const row of [form.value.lead, ...form.value.members]) {
    if (row.host) names.add(row.host);
  }
  return [...names];
});

const inheritHostLabel = computed(() =>
  form.value.host
    ? `继承默认宿主（${hostDisplayLabel(form.value.host)}）`
    : '继承默认宿主（未选择）',
);

const isLocked = computed(() => busy.value || form.value.submitted || Boolean(form.value.group));
const canCreate = computed(() => Boolean(form.value.group)
  || Boolean(
    form.value.name.trim()
    && form.value.text.trim()
    && form.value.workspace
    && activeRows(form.value).every((row) => Boolean(row.host || form.value.host)),
  ));

interface MatrixRow {
  row: DraftMember;
  isLead: boolean;
  index: number;
  label: string;
}

const matrixRows = computed<MatrixRow[]>(() => [
  { row: form.value.lead, isLead: true, index: 0, label: '主 Agent' },
  ...form.value.members.map((row, index) => ({
    row,
    isLead: false,
    index: index + 1,
    label: `协作成员 ${index + 1}`,
  })),
]);

const memberSummaries = computed(() => buildMemberSummaries(form.value, {
  defaultHost: form.value.host,
  hostLabel: (host) => hostDisplayLabel(host),
  modelLabel: (row) => modelLabel(row, catalogHosts.value, form.value.host),
}));

const shellHint = computed(() => {
  if (form.value.policy === 'communication') return '仅沟通策略下不能执行命令。';
  if (form.value.policy === 'read-only') {
    return form.value.allowShell
      ? '只读策略下仅 Codex 等沙箱命令宿主会保留只读命令能力；若关闭，Codex 将退化为仅沟通。'
      : '已关闭执行命令：只读成员禁止 shell，Codex 成员会因缺少沙箱命令退化为仅沟通。';
  }
  return form.value.allowShell
    ? '成员可执行 shell 命令；可按成员再单独关闭。'
    : '已关闭执行命令，成员仍可读写工作文件夹（Codex 成员除外，无 shell 将退化为仅沟通）。';
});

watch(form, (value) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 保留内存中的草稿即可。
  }
}, { deep: true });

// 摘要展示后任何字段变化都要回到待确认状态,避免按旧摘要建群。
watch(form, () => {
  if (confirming.value) confirming.value = false;
}, { deep: true });

// 群策略向下调严:成员上限自动收敛到新上限以内,并提示被收敛的成员数。
watch(() => form.value.policy, (policy) => {
  if (form.value.group) return;
  const rows = [form.value.lead, ...form.value.members];
  const clamped = rows.filter((row) => row.policyCeiling && clampPolicyCeiling(row.policyCeiling, policy) !== row.policyCeiling).length;
  form.value.lead.policyCeiling = clampPolicyCeiling(form.value.lead.policyCeiling, policy);
  for (const row of form.value.members) row.policyCeiling = clampPolicyCeiling(row.policyCeiling, policy);
  if (policy === 'communication') {
    form.value.allowShell = false;
    form.value.lead.allowBrowser = false;
    for (const row of form.value.members) {
      row.allowBrowser = false;
      row.workspaceMode = 'inherit';
    }
  }
  policyNotice.value = clamped
    ? `群策略已调严，${clamped} 个成员的权限上限已收敛到「${policyLabel(policy)}」以内。`
    : '';
  confirming.value = false;
});

let pickAbort: AbortController | null = null;
function cancelPicking() {
  pickAbort?.abort();
  pickAbort = null;
  picking.value = false;
}
async function chooseDirectory() {
  if (picking.value) {
    cancelPicking();
    return;
  }
  const controller = new AbortController();
  pickAbort = controller;
  picking.value = true;
  error.value = '';
  try {
    const result = await api.chooseDirectory(controller.signal);
    if (controller.signal.aborted) return;
    if (result.path) form.value.workspace = result.path;
  } catch (cause) {
    if (controller.signal.aborted) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (pickAbort === controller) {
      pickAbort = null;
      picking.value = false;
    }
  }
}
onBeforeUnmount(cancelPicking);

function setDefaultHost(host: string) {
  if (form.value.host === host) return;
  form.value.host = host;
  // 继承默认宿主的成员行,其模型选择随默认宿主一起失效。
  for (const row of [form.value.lead, ...form.value.members]) {
    if (row.host) continue;
    row.model_provider = '';
    row.model = '';
    row.reasoning_effort = '';
  }
}

function setGroupAllowShell(value: boolean) {
  if (form.value.policy === 'communication') return;
  form.value.allowShell = value;
}

function addMember() {
  if (isLocked.value) return;
  form.value.members.push(newDraftMember());
}

function removeMember(id: string) {
  if (isLocked.value) return;
  const index = form.value.members.findIndex((row) => row.id === id);
  if (index >= 0) form.value.members.splice(index, 1);
}

function applyPreset(kind: PresetKind) {
  if (isLocked.value) return;
  form.value.members = presetMembers(kind, {
    defaultHost: form.value.host,
    availableHosts: hostChoices.value,
    groupPolicy: form.value.policy,
  }).map((row) => ({
    ...row,
    policyCeiling: clampPolicyCeiling(row.policyCeiling, form.value.policy),
    allowBrowser: row.allowBrowser && !browserRestrictedReason(form.value.policy),
  }));
  policyNotice.value = '';
}

function setMemberHost(row: DraftMember, value: unknown) {
  if (isLocked.value) return;
  const host = String(value) === INHERIT ? '' : String(value);
  if (row.host === host) return;
  row.host = host;
  // 宿主变化后原有模型选择可能不属于新宿主的目录,回到宿主默认。
  row.model_provider = '';
  row.model = '';
  row.reasoning_effort = '';
}

function setMemberPolicyCeiling(row: DraftMember, value: unknown) {
  if (isLocked.value) return;
  const ceiling = String(value) === INHERIT ? '' : String(value);
  row.policyCeiling = clampPolicyCeiling(ceiling, form.value.policy);
  const effective = effectivePolicy(row, form.value.policy);
  if (browserRestrictedReason(effective)) row.allowBrowser = false;
  if (worktreeRestrictedReason(effective, row.id === form.value.lead.id)) row.workspaceMode = 'inherit';
}

function setMemberBrowser(row: DraftMember, value: boolean) {
  if (isLocked.value || browserRestrictedReason(effectivePolicy(row, form.value.policy))) return;
  row.allowBrowser = Boolean(value);
}

function worktreeDisabled(item: MatrixRow): boolean {
  return isLocked.value || Boolean(worktreeRestrictedReason(effectivePolicy(item.row, form.value.policy), item.isLead));
}

function worktreeHint(item: MatrixRow): string {
  const restricted = worktreeRestrictedReason(effectivePolicy(item.row, form.value.policy), item.isLead);
  if (restricted) return restricted;
  return '开启后框架为该成员创建独立 Git 分支与受管 worktree，禁止并发覆写主工作区；仅在有效 Git 仓库根目录且已有提交时可用。';
}

function setMemberWorkspaceMode(item: MatrixRow, enabled: boolean) {
  if (worktreeDisabled(item)) return;
  item.row.workspaceMode = enabled ? 'worktree' : 'inherit';
}

function applyWorkflowTemplate(value: unknown) {
  if (isLocked.value) return;
  const nextId = String(value) === NO_TEMPLATE ? '' : String(value);
  form.value.workflowTemplate = nextId;
  charterNotice.value = '';
  const template = workflowTemplates.value.find((item) => item.id === nextId) ?? null;
  if (!template) {
    if (form.value.charter.trim() === lastTemplateCharter.value.trim()) {
      form.value.charter = '';
    }
    lastTemplateCharter.value = '';
    return;
  }
  form.value.members = membersFromWorkflowTemplate(template, {
    defaultHost: form.value.host,
    availableHosts: hostChoices.value,
    groupPolicy: form.value.policy,
  });
  const currentCharter = form.value.charter.trim();
  if (!currentCharter || currentCharter === lastTemplateCharter.value.trim()) {
    form.value.charter = template.charter;
    lastTemplateCharter.value = template.charter;
  } else {
    charterNotice.value = '保留了你手动编辑的团队说明；如需改用当前模板默认规范，可点击右侧按钮填入。';
  }
  policyNotice.value = '';
}

function applyTemplateCharterForce() {
  if (isLocked.value || !selectedTemplate.value) return;
  form.value.charter = selectedTemplate.value.charter;
  lastTemplateCharter.value = selectedTemplate.value.charter;
  charterNotice.value = '';
}

function applyModel(row: DraftMember, value: { host: string; model_provider: string; model: string; reasoning_effort: string }) {
  if (isLocked.value) return;
  if (value.host && value.host !== resolveMemberHost(row, form.value.host)) row.host = value.host;
  // 未选模型时整体回到宿主默认:后端不接受只带思考强度的部分选择。
  row.model_provider = value.model ? value.model_provider : '';
  row.model = value.model;
  row.reasoning_effort = value.model ? value.reasoning_effort : '';
}

function resetModel(row: DraftMember) {
  if (isLocked.value) return;
  row.model_provider = '';
  row.model = '';
  row.reasoning_effort = '';
}

function resolvedHost(row: DraftMember): string {
  return resolveMemberHost(row, form.value.host);
}

function canPickModel(row: DraftMember): boolean {
  const host = resolvedHost(row);
  return Boolean(host) && catalogHosts.value.some((item) => item.host === host);
}

function browserDisabled(row: DraftMember): boolean {
  return isLocked.value || Boolean(browserRestrictedReason(effectivePolicy(row, form.value.policy)));
}

function browserHint(row: DraftMember): string {
  const restricted = browserRestrictedReason(effectivePolicy(row, form.value.policy));
  if (restricted) return restricted;
  return `实际工具由宿主能力与运行期探测决定；${hostDisplayLabel(resolvedHost(row))} 若未报告浏览器工具，创建后仍会显示为不可用。`;
}

async function submit() {
  if (busy.value || !canCreate.value) return;
  error.value = '';
  if (picking.value) cancelPicking();
  const body = buildCreateGroupBody(form.value);
  if (!body.lead.host) {
    error.value = '请选择默认宿主，或为每位成员单独选择宿主';
    confirming.value = false;
    return;
  }
  if (unknownModelMemberNames(form.value, catalogHosts.value).length) {
    error.value = `所选模型不在实时目录中：${unknownModelMemberNames(form.value, catalogHosts.value).join('、')}。请重新选择，或留空使用宿主默认。`;
    confirming.value = false;
    return;
  }
  const names = [body.lead.name, ...body.members.map((member) => member.name)];
  if (new Set(names).size !== names.length) {
    error.value = '成员名称不能重复';
    confirming.value = false;
    return;
  }
  // 首次提交只展开确认摘要,用户确认后才真正创建。
  if (!form.value.group && !confirming.value) {
    confirming.value = true;
    await nextTick();
    confirmCard.value?.$el?.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  confirming.value = false;
  form.value.submitted = true;
  busy.value = true;
  error.value = '';
  try {
    if (!form.value.group) form.value.group = await api.createGroup(body);
    const group = form.value.group!;
    if (!group.lead) throw new Error('团队没有可用的主 Agent');
    await api.sendTeamDirective(group.id, {
      operationId: `${form.value.operationId}-first`,
      text: form.value.text.trim(),
      controllerId: group.lead,
    });
    await invalidateWorkspaceResources(client);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // 建群已成功,草稿清理失败不影响流程。
    }
    await router.push({ name: 'group', params: { groupId: group.id } });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    if (!form.value.group && cause instanceof ApiError && cause.status === 400) form.value.submitted = false;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl p-4">
    <Card>
      <CardHeader>
        <CardTitle>创建团队</CardTitle>
        <CardDescription>先确认默认宿主与全局权限；需要不同宿主、模型或更严权限时，在下方成员矩阵逐人覆写。创建成员会调用模型进行能力自述，产生正常调用消耗。</CardDescription>
      </CardHeader>
      <form @submit.prevent="submit">
        <CardContent class="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel for="team-name">团队名称</FieldLabel>
              <Input id="team-name" v-model="form.name" :disabled="isLocked" required maxlength="200" />
            </Field>
            <Field>
              <FieldLabel for="team-request">要完成什么？</FieldLabel>
              <Textarea id="team-request" v-model="form.text" :disabled="isLocked" required maxlength="48000" placeholder="描述需求、使用材料和希望得到的结果" />
            </Field>
            <Field>
              <FieldLabel>研发工作流模板（可选）</FieldLabel>
              <Select
                :model-value="form.workflowTemplate || NO_TEMPLATE"
                :disabled="isLocked"
                data-testid="workflow-template"
                @update:model-value="applyWorkflowTemplate"
              >
                <SelectTrigger aria-label="研发工作流模板"><SelectValue>{{ selectedTemplate?.name ?? '自由协作（不套用模板）' }}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem :value="NO_TEMPLATE">自由协作（不套用模板）</SelectItem>
                    <SelectItem v-for="tpl in workflowTemplates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{{ selectedTemplate ? selectedTemplate.summary : '仅提供成员预设与协作规范（大文档写文件传路径、不贴全文），绝不锁死沟通顺序。' }}</FieldDescription>
            </Field>
            <Field v-if="form.workflowTemplate || form.charter.trim()">
              <div class="flex items-center justify-between gap-2">
                <FieldLabel for="team-charter">团队说明与协作规范（Charter，可选）</FieldLabel>
                <Button
                  v-if="charterNotice && selectedTemplate"
                  type="button"
                  variant="link"
                  size="sm"
                  :disabled="isLocked"
                  @click="applyTemplateCharterForce"
                >
                  填入模板默认规范
                </Button>
              </div>
              <Textarea id="team-charter" v-model="form.charter" :disabled="isLocked" maxlength="48000" rows="4" placeholder="注入团队每回合上下文的协作规范与约束说明（仅作上下文参考）" />
              <p v-if="charterNotice" class="text-xs text-muted-foreground">{{ charterNotice }}</p>
            </Field>
            <Field>
              <FieldLabel>默认 AI 工具</FieldLabel>
              <p v-if="form.host" class="text-sm text-muted-foreground">已选择：{{ hostDisplayLabel(form.host) }}</p>
              <HostStatuses v-if="!form.group" :active="true" :selectable="!isLocked" :selected="form.host" @select="setDefaultHost" />
              <FieldDescription>未单独指定宿主的成员默认继承此宿主与模型。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel for="team-directory">工作文件夹</FieldLabel>
              <div class="flex gap-2">
                <Input id="team-directory" v-model="form.workspace" :disabled="isLocked" placeholder="选择文件夹或粘贴路径" />
                <Button type="button" variant="outline" :disabled="isLocked" @click="chooseDirectory">{{ picking ? '取消选择' : '选择' }}</Button>
              </div>
              <p v-if="picking" class="text-sm text-muted-foreground">已打开系统文件夹选择窗口，也可直接粘贴路径。</p>
            </Field>
            <Field>
              <FieldLabel>文件访问范围</FieldLabel>
              <Select v-model="form.policy" :disabled="isLocked" data-testid="group-policy">
                <SelectTrigger aria-label="文件访问范围"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem v-for="mode in POLICY_MODES" :key="mode" :value="mode">{{ policyLabel(mode) }}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>这是全群权限天花板；成员的有效权限不会超过此范围。团队说明和聊天中的确认不会改变此权限。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel for="team-allow-shell">允许执行命令</FieldLabel>
              <div class="flex flex-wrap items-center gap-3">
                <Switch id="team-allow-shell" data-testid="group-shell-toggle" :model-value="form.allowShell" :disabled="isLocked || form.policy === 'communication'" aria-label="允许执行命令" @update:model-value="setGroupAllowShell" />
                <span class="text-sm text-muted-foreground">{{ shellHint }}</span>
              </div>
            </Field>
          </FieldGroup>

          <p v-if="policyNotice" role="status" data-testid="policy-notice" class="text-sm text-muted-foreground">{{ policyNotice }}</p>

          <SectionBlock title="成员矩阵" :heading-level="3" tone="muted" size="sm" class="gap-3">
            <template #meta>
              <span class="text-xs text-muted-foreground">{{ matrixRows.length }} 位成员 · 主 Agent + 0..N 协作成员</span>
            </template>
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-muted-foreground">快捷预设</span>
              <Button type="button" variant="outline" size="sm" :disabled="isLocked" @click="applyPreset('minimal')">极简（1 协作成员）</Button>
              <Button type="button" variant="outline" size="sm" :disabled="isLocked" @click="applyPreset('dev-review')">研发 + 只读验收双人组</Button>
            </div>

            <SectionBlock
              v-for="item in matrixRows"
              :key="item.row.id"
              :data-testid="item.isLead ? 'member-row-lead' : 'member-row-' + item.index"
              :tone="item.isLead ? 'default' : 'dashed'"
              size="sm"
              :heading-level="4"
              class="gap-3"
            >
              <template #header>
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <h4 class="text-xs font-semibold tracking-wide text-muted-foreground">{{ item.label }}</h4>
                  <span v-if="!item.row.model" class="truncate text-xs text-muted-foreground">继承默认宿主与模型</span>
                  <span v-else class="truncate text-xs text-muted-foreground">{{ hostDisplayLabel(resolvedHost(item.row)) }} · {{ modelLabel(item.row, catalogHosts, form.host) }}</span>
                </div>
                <Button
                  v-if="!item.isLead"
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  :disabled="isLocked"
                  :data-testid="'remove-member-' + item.index"
                  :aria-label="`删除协作成员 ${item.index}`"
                  @click="removeMember(item.row.id)"
                >
                  <Trash2 class="size-4" />
                </Button>
              </template>
              <div class="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel :for="`member-name-${item.row.id}`">名称</FieldLabel>
                  <Input
                    :id="`member-name-${item.row.id}`"
                    v-model="item.row.name"
                    :disabled="isLocked"
                    maxlength="100"
                    :placeholder="item.isLead ? '主 Agent' : '协作成员名称'"
                  />
                </Field>
                <Field>
                  <FieldLabel :for="`member-host-${item.row.id}`">宿主</FieldLabel>
                  <Select
                    :model-value="item.row.host || INHERIT"
                    :disabled="isLocked"
                    :data-testid="'member-host-' + item.index"
                    @update:model-value="setMemberHost(item.row, $event)"
                  >
                    <SelectTrigger :id="`member-host-${item.row.id}`" :aria-label="`${item.label} 宿主`"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem :value="INHERIT">{{ inheritHostLabel }}</SelectItem>
                        <SelectItem v-for="choice in hostChoices" :key="choice" :value="choice">{{ hostDisplayLabel(choice) }}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>默认继承上方宿主，可单独指定。</FieldDescription>
                </Field>
                <Field class="sm:col-span-2">
                  <FieldLabel>模型与思考强度</FieldLabel>
                  <MemberModelField
                    :data-testid="'member-model-' + item.index"
                    :hosts="catalogHosts"
                    :host="resolvedHost(item.row)"
                    :model-provider="item.row.model_provider"
                    :model="item.row.model"
                    :reasoning-effort="item.row.reasoning_effort"
                    :disabled="isLocked || !canPickModel(item.row)"
                    @change="applyModel(item.row, $event)"
                  />
                  <div v-if="item.row.model" class="flex justify-end">
                    <Button type="button" variant="link" size="sm" :disabled="isLocked" @click="resetModel(item.row)">恢复宿主默认</Button>
                  </div>
                  <FieldDescription>未选择时使用宿主默认模型；实时目录离线时也可以直接创建。</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel :for="`member-ceiling-${item.row.id}`">成员权限上限</FieldLabel>
                  <Select
                    :model-value="item.row.policyCeiling || INHERIT"
                    :disabled="isLocked"
                    :data-testid="'member-ceiling-' + item.index"
                    @update:model-value="setMemberPolicyCeiling(item.row, $event)"
                  >
                    <SelectTrigger :id="`member-ceiling-${item.row.id}`" :aria-label="`${item.label} 权限上限`">
                      <SelectValue>{{ item.row.policyCeiling ? policyLabel(item.row.policyCeiling) : `继承群策略（${policyLabel(form.policy)}）` }}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem :value="INHERIT">继承群策略（{{ policyLabel(form.policy) }}）</SelectItem>
                        <SelectItem v-for="mode in policyCeilingOptions(form.policy)" :key="mode" :value="mode">{{ policyLabel(mode) }}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>只能比群策略更严；群策略调严时自动收敛。</FieldDescription>
                </Field>
                <Field>
                  <div class="flex items-start gap-3">
                    <div class="min-w-0 flex-1 space-y-1">
                      <FieldLabel :for="`member-browser-${item.row.id}`">允许浏览器 / Computer Use</FieldLabel>
                      <FieldDescription>{{ browserHint(item.row) }}</FieldDescription>
                    </div>
                    <Switch
                      :id="`member-browser-${item.row.id}`"
                      :data-testid="'member-browser-' + item.index"
                      :model-value="item.row.allowBrowser"
                      :disabled="browserDisabled(item.row)"
                      :aria-label="`${item.label} 允许浏览器`"
                      @update:model-value="setMemberBrowser(item.row, $event)"
                    />
                  </div>
                </Field>
                <Field v-if="!item.isLead" class="sm:col-span-2">
                  <div class="flex items-start gap-3">
                    <div class="min-w-0 flex-1 space-y-1">
                      <FieldLabel :for="`member-worktree-${item.row.id}`">独立工作区（git worktree）</FieldLabel>
                      <FieldDescription>{{ worktreeHint(item) }}</FieldDescription>
                    </div>
                    <Switch
                      :id="`member-worktree-${item.row.id}`"
                      :data-testid="'member-worktree-' + item.index"
                      :model-value="item.row.workspaceMode === 'worktree'"
                      :disabled="worktreeDisabled(item)"
                      :aria-label="`${item.label} 独立 worktree`"
                      @update:model-value="setMemberWorkspaceMode(item, $event)"
                    />
                  </div>
                </Field>
              </div>
            </SectionBlock>

            <div>
              <Button type="button" variant="outline" size="sm" data-testid="add-member" :disabled="isLocked" @click="addMember">+ 添加成员</Button>
            </div>
          </SectionBlock>

          <NoteBlock v-if="confirming && !form.group" ref="confirmCard" size="md" class="p-4" data-testid="create-team-confirm">
            <p class="font-medium">确认创建以下团队？</p>
            <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt class="text-muted-foreground">名称</dt><dd class="break-words">{{ form.name.trim() }}</dd>
              <dt class="text-muted-foreground">工作文件夹</dt><dd class="break-all">{{ form.workspace }}</dd>
              <dt class="text-muted-foreground">文件访问</dt><dd>{{ policyLabel(form.policy) }}<span v-if="!form.allowShell" class="text-muted-foreground">（不允许执行命令）</span></dd>
              <dt v-if="selectedTemplate" class="text-muted-foreground">工作流模板</dt><dd v-if="selectedTemplate">{{ selectedTemplate.name }}</dd>
              <dt class="text-muted-foreground">成员</dt><dd>{{ memberSummaries.length }} 位</dd>
              <dt class="text-muted-foreground">需求</dt><dd class="line-clamp-3 whitespace-pre-wrap">{{ form.text.trim() }}</dd>
            </dl>
            <ul class="mt-4 flex flex-col gap-2">
              <li v-for="member in memberSummaries" :key="member.id" data-testid="member-summary" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span class="font-medium">{{ member.name }}</span>
                <span class="text-muted-foreground">{{ member.hostLabel }}</span>
                <span class="text-muted-foreground">· 模型：{{ member.modelLabel }}</span>
                <span class="text-muted-foreground">· 权限：{{ member.policyLabel }}</span>
                <span class="text-muted-foreground">· 浏览器：{{ member.browserLabel }}</span>
                <span class="text-muted-foreground">· 工作区：{{ member.workspaceLabel }}</span>
              </li>
            </ul>
            <div class="mt-4 flex gap-2">
              <Button type="button" :disabled="busy" @click="submit">确认创建</Button>
              <Button type="button" variant="ghost" :disabled="busy" @click="confirming = false">返回修改</Button>
            </div>
          </NoteBlock>
          <p v-if="form.submitted && !form.group && !busy" class="text-sm text-muted-foreground">创建结果尚未确认，请重试同一请求以找回结果。</p>
          <Alert v-if="form.group"><AlertDescription>团队已创建。需求发送未确认时，再次提交会使用同一请求重试，不会重新建群。<RouterLink :to="`/groups/${form.group.id}`">进入团队</RouterLink></AlertDescription></Alert>
          <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>
        </CardContent>
        <CardFooter class="flex gap-3">
          <Button v-if="!confirming || form.group" type="submit" :disabled="busy || !canCreate">{{ busy ? '提交中…' : form.group ? '重试发送需求' : '创建并发送需求' }}</Button>
          <Button as-child variant="ghost"><RouterLink to="/groups">返回工作台</RouterLink></Button>
        </CardFooter>
      </form>
    </Card>
  </div>
</template>
