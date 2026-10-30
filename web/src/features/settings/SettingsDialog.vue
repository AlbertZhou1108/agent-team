<script setup lang="ts">
import HelpPopover from '@/components/panel/HelpPopover.vue';
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Monitor,
  Moon,
  Sun,
} from '@lucide/vue';
import { api } from '@/shared/api/client';
import type {
  Group,
  ModelPolicy,
  ModelPolicyDefaults,
  ModelPolicyPreset,
} from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import HostStatuses from './HostStatuses.vue';
import { usePreferencesStore, type ColorMode } from '@/stores/preferences';

const props = defineProps<{
  open: boolean;
  embedded?: boolean;
  policy?: ModelPolicy;
  defaults?: ModelPolicyDefaults;
  archivedTeams?: Group[];
}>();

const emit = defineEmits<{
  close: [];
  saved: [policy: ModelPolicy];
  restoreTeam: [team: Group];
}>();

const preferences = usePreferencesStore();
const archivedOpen = ref(true);
const mode = ref<ModelPolicy['mode']>('user');
const rules = ref('');
const saving = ref(false);
const error = ref('');

const colorModes: Array<{ value: ColorMode; icon: typeof Sun; label: string }> =
  [
    { value: 'system', icon: Monitor, label: '跟随系统' },
    { value: 'light', icon: Sun, label: '浅色' },
    { value: 'dark', icon: Moon, label: '深色' },
  ];

const originalMode = computed(() => props.policy?.mode ?? 'user');
const originalRules = computed(
  () => props.policy?.rules ?? props.defaults?.user ?? '',
);
// 选中哪份配置也是变更的一部分:两份配置文本可能相同,但"当前生效的是哪份"仍需改变。
const hasPolicyChanges = computed(
  () =>
    mode.value !== originalMode.value ||
    rules.value.trim() !== originalRules.value.trim() ||
    (loadedPresetId.value ?? null) !== (props.policy?.preset_id ?? null),
);
const canSave = computed(() =>
  Boolean(rules.value.trim() && hasPolicyChanges.value && !saving.value),
);
const smartPresets = computed(() => [
  {
    value: 'performance',
    label: '性能优先',
    rules: props.defaults?.smart.performance ?? '',
  },
  {
    value: 'cost',
    label: '成本优先',
    rules: props.defaults?.smart.cost ?? '',
  },
]);
const activeSmartPreset = computed(() =>
  mode.value === 'smart'
    ? (smartPresets.value.find(
        (item) => item.rules && item.rules.trim() === rules.value.trim(),
      )?.value ?? null)
    : null,
);

// 两个模式各自的编辑草稿:来回切换不丢失已载入/已修改的内容。
const modeDrafts = ref<Record<ModelPolicy['mode'], { rules: string; presetId: string | null }>>({
  smart: { rules: '', presetId: null },
  user: { rules: '', presetId: null },
});
function rememberModeDraft() {
  modeDrafts.value[mode.value] = { rules: rules.value, presetId: loadedPresetId.value };
}

function reset() {
  mode.value = props.policy?.mode ?? 'user';
  rules.value = props.policy?.rules ?? props.defaults?.user ?? '';
  // 选中项严格来自后端记录的来源 id:内置默认规则用哨兵值,自建配置用真实 id。
  // 没有记录(手写规则)时不选中任何一项。
  loadedPresetId.value = props.policy?.preset_id ?? null;
  modeDrafts.value = {
    smart: { rules: props.defaults?.smart.cost ?? '', presetId: null },
    user: { rules: props.defaults?.user ?? '', presetId: null },
  };
  rememberModeDraft();
  error.value = '';
}

function selectMode(next: ModelPolicy['mode']) {
  if (mode.value === next) return;
  // 记住当前模式草稿,切回时恢复;首次进入该模式用默认规则。
  rememberModeDraft();
  mode.value = next;
  const draft = modeDrafts.value[next];
  rules.value = draft.rules || (next === 'smart' ? (props.defaults?.smart.cost ?? '') : (props.defaults?.user ?? ''));
  loadedPresetId.value = draft.presetId;
}

function selectPolicyMode(value: unknown) {
  if (value === 'smart' || value === 'user') selectMode(value);
}

function selectColorMode(value: unknown) {
  if (value === 'dark' || value === 'light' || value === 'system') {
    preferences.setColorMode(value);
  }
}

function useRule(value?: string) {
  if (!value) return;
  rules.value = value;
  loadedPresetId.value = null;
  rememberModeDraft();
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = '';
  try {
    const policy = await api.updateModelPolicy(
      mode.value,
      rules.value,
      sourcePresetIdForSave(),
    );
    emit('saved', policy);
    rememberModeDraft();
    if (!props.embedded) emit('close');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

// 自定义配置:编辑辅助层,存服务端;载入后走既有保存流程激活。
const presetsQuery = useQuery({
  queryKey: ['model-policy-presets'],
  queryFn: ({ signal }) => api.modelPolicyPresets(signal),
  enabled: computed(() => props.open || Boolean(props.embedded)),
});
const presets = computed(() => presetsQuery.data.value ?? []);
// 内置默认规则作为固定首行:用户配置的基线始终可见可选;内置不可改,想调整就创建为自己的配置。
const builtInPreset = computed<ModelPolicyPreset | null>(() => {
  const rules = props.defaults?.user ?? '';
  return rules ? { id: '__builtin_default__', name: '默认规则', mode: 'user', rules, created: '', updated: '' } : null;
});
const listedPresets = computed(() => {
  const builtIn = builtInPreset.value;
  return builtIn ? [builtIn, ...presets.value] : presets.value;
});
// 配置可能很多:整块折叠,列表在固定高度内滚动,不会把设置页拉长。
const presetsOpen = ref(true);
// 用户从配置载入规则时记录来源 id,保存时随策略一起提交,内容相同的配置也能区分。
const loadedPresetId = ref<string | null>(null);
const activePresetId = computed(() => props.policy?.preset_id ?? null);
const creatingPreset = ref(false);
// 创建表单是独立草稿:规则不给默认值,由用户从空白开始填写。
// 配置本身属于「用户配置」模式,不需要选择模式。
const newPreset = ref<{ name: string; rules: string }>({ name: '', rules: '' });
const canCreatePreset = computed(() =>
  Boolean(newPreset.value.name.trim() && newPreset.value.rules.trim()),
);
const renamingPreset = ref<{ id: string; name: string } | null>(null);
const deletingPreset = ref<ModelPolicyPreset | null>(null);

async function refreshPresets() {
  await presetsQuery.refetch();
}
function beginCreatePreset() {
  newPreset.value = { name: '', rules: '' };
  creatingPreset.value = true;
}
async function submitCreatePreset() {
  if (!canCreatePreset.value) return;
  try {
    await api.createModelPolicyPreset({
      name: newPreset.value.name.trim(),
      mode: 'user',
      rules: newPreset.value.rules,
    });
    creatingPreset.value = false;
    await refreshPresets();
    toast.success('配置已创建');
  } catch (cause) {
    toast.error('创建配置失败', { description: cause instanceof Error ? cause.message : String(cause) });
  }
}
// 点配置 = 直接选中它(与模式切换同一种交互):编辑器立即换成该配置,
// 顶部出现"保存";保存后它才成为全局生效策略。
function loadPreset(preset: ModelPolicyPreset) {
  rememberModeDraft();
  mode.value = preset.mode;
  rules.value = preset.rules;
  loadedPresetId.value = preset.id;
  rememberModeDraft();
}
// 选中的就是当前选中的那条配置;一次性只高亮一条。
// 选中的就是当前选中的那条配置;一次性只高亮一条。
function presetState(preset: ModelPolicyPreset) {
  return preset.id === loadedPresetId.value ? 'selected' : null;
}
function isPresetSelected(preset: ModelPolicyPreset) {
  return presetState(preset) !== null;
}
const activePresetName = computed(() => {
  const id = activePresetId.value;
  if (!id) return null;
  return presets.value.find(item => item.id === id)?.name ?? null;
});
// 当前选中配置的名称,用于"已切换到 X"提示。
const editingPresetName = computed(() => {
  const id = loadedPresetId.value;
  if (!id) return null;
  if (id === '__builtin_default__') return '默认规则';
  return presets.value.find(item => item.id === id)?.name ?? null;
});
// 保存时提交的来源:内置默认规则用固定哨兵值(后端同样认可),
// 自建配置要求内容未被改动,否则不再归属该配置。
function sourcePresetIdForSave() {
  const id = loadedPresetId.value;
  if (!id) return null;
  if (id === '__builtin_default__') return id;
  const preset = presets.value.find(item => item.id === id);
  return preset && preset.rules.trim() === rules.value.trim() ? id : null;
}
// 规则统一在弹窗中展示/编辑:preset=null 表示当前策略规则。
const rulesDialog = ref<{ mode: 'view' | 'edit'; preset: ModelPolicyPreset | null } | null>(null);
const rulesDraft = ref('');
const rulesDialogTitle = computed(() =>
  rulesDialog.value?.preset ? rulesDialog.value.preset.name : '当前策略规则',
);
const rulesDialogRules = computed(() =>
  rulesDialog.value?.preset ? rulesDialog.value.preset.rules : rules.value,
);
function openRulesDialog({ mode, preset = null }: { mode: 'view' | 'edit'; preset?: ModelPolicyPreset | null }) {
  rulesDraft.value = preset ? preset.rules : rules.value;
  rulesDialog.value = { mode, preset };
}
function applyRulesDraft() {
  if (!rulesDraft.value.trim()) return;
  const preset = rulesDialog.value?.preset;
  const edited = Boolean(preset) && rulesDraft.value !== preset!.rules;
  rules.value = rulesDraft.value;
  if (preset) mode.value = preset.mode;
  // 内容被改过就不再属于原配置(避免高亮仍指向它);原样应用才记录来源。
  loadedPresetId.value = !preset || edited || preset.id === '__builtin_default__' ? null : preset.id;
  rulesDialog.value = null;
  toast.success(edited
    ? '已应用修改后的规则，保存后生效（内容已不同于原配置）'
    : '规则已应用到编辑器，保存后生效');
}
function switchRulesDialogToEdit() {
  if (!rulesDialog.value) return;
  rulesDraft.value = rulesDialogRules.value;
  rulesDialog.value = { ...rulesDialog.value, mode: 'edit' };
}
function editPreset(preset: ModelPolicyPreset) {
  openRulesDialog({ mode: 'edit', preset });
}
async function submitRenamePreset() {
  if (!renamingPreset.value) return;
  try {
    await api.renameModelPolicyPreset(renamingPreset.value.id, renamingPreset.value.name);
    renamingPreset.value = null;
    await refreshPresets();
  } catch (cause) {
    toast.error('重命名失败', { description: cause instanceof Error ? cause.message : String(cause) });
  }
}
async function confirmDeletePreset() {
  if (!deletingPreset.value) return;
  const deletedId = deletingPreset.value.id;
  try {
    await api.deleteModelPolicyPreset(deletedId);
    // 删掉的正是当前选中项时清除选中,避免高亮指向已不存在的配置。
    if (loadedPresetId.value === deletedId) loadedPresetId.value = null;
    deletingPreset.value = null;
    await refreshPresets();
    toast.success('配置已删除');
  } catch (cause) {
    toast.error('删除失败', { description: cause instanceof Error ? cause.message : String(cause) });
  }
}
function presetDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(value));
}

watch(
  () => [
    props.open,
    props.embedded,
    props.policy?.mode,
    props.policy?.rules,
    props.defaults,
  ],
  () => {
    if (props.open || props.embedded) reset();
  },
  { immediate: true },
);
</script>

<template>
  <Dialog
    :open="open && !embedded"
    @update:open="
      (value) => {
        if (!value) emit('close');
      }
    "
  >
    <div :class="embedded ? 'settings-page' : undefined">
      <component
        :is="embedded ? Card : DialogContent"
        v-if="open || embedded"
        :class="
          embedded
            ? 'settings-page-panel'
            : 'max-h-[calc(100vh-2rem)] overflow-y-auto'
        "
      >
        <CardHeader class="flex shrink-0 flex-row items-center">
          <Button
            v-if="embedded"
            variant="ghost"
            size="icon"
            title="返回"
            aria-label="返回"
            @click="emit('close')"
          >
            <ArrowLeft />
          </Button>
          <div class="min-w-0 flex-1">
            <h1 v-if="embedded" class="text-2xl font-semibold">设置</h1>
            <DialogTitle v-else>设置</DialogTitle>
          </div>
        </CardHeader>

        <CardContent class="min-h-0 flex-1 overflow-y-auto flex flex-col gap-6">
          <HostStatuses :active="open || Boolean(embedded)" />
          <section class="flex flex-col gap-3">
            <div>
              <h3 class="text-sm font-semibold">显示模式</h3>
            </div>
            <ToggleGroup
              type="single"
              :model-value="preferences.colorMode"
              :spacing="2"
              class="display-mode-group grid w-full grid-cols-3"
              @update:model-value="selectColorMode"
            >
              <ToggleGroupItem
                v-for="item in colorModes"
                :key="item.value"
                :value="item.value"
                variant="outline"
                class="display-mode-option min-w-0"
              >
                <component :is="item.icon" />
                <span>{{ item.label }}</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </section>

          <section class="flex flex-col gap-3">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-1"><h3 class="text-sm font-semibold">思考过程</h3><HelpPopover title="思考过程"><p>在会话和消息流中显示模型的实时思考与“宿主思考”步骤。</p></HelpPopover></div>
              </div>
              <Switch
                :model-value="preferences.showReasoning"
                class="shrink-0"
                aria-label="显示思考过程"
                @update:model-value="preferences.setShowReasoning(Boolean($event))"
              />
            </div>
          </section>

          <section class="flex flex-col gap-3 pt-6">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-1"><h3 class="text-sm font-semibold">模型策略</h3><HelpPopover title="模型策略"><p>全局策略在创建新团队和已有团队新增角色时读取；已有角色模型不会被改写。</p></HelpPopover></div>
                <p v-if="hasPolicyChanges" class="mt-1 text-xs text-foreground">
                  已切换到「{{ editingPresetName ?? '手写规则' }}」，点保存后生效。
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" @click="openRulesDialog({ mode: 'view' })">
                  当前规则
                </Button>
                <Button
                  v-if="hasPolicyChanges"
                  size="sm"
                  :disabled="!canSave"
                  @click="save"
                >
                  {{ saving ? '保存中…' : '保存' }}
                </Button>
              </div>
            </div>

            <ToggleGroup
              type="single"
              :model-value="mode"
              :spacing="2"
              class="grid w-full grid-cols-2"
              @update:model-value="selectPolicyMode"
            >
              <ToggleGroupItem
                value="smart"
                variant="outline"
                :data-selected="mode === 'smart'"
                class="min-w-0 justify-start"
              >
                <span class="flex-1 text-left font-medium">智能策略</span>
              </ToggleGroupItem>
              <ToggleGroupItem
                value="user"
                variant="outline"
                :data-selected="mode === 'user'"
                class="min-w-0 justify-start"
              >
                <span class="flex-1 text-left font-medium">用户配置</span>
              </ToggleGroupItem>
            </ToggleGroup>

            <div v-if="mode === 'smart'" class="flex flex-col gap-2">
              <ToggleGroup
                type="single"
                :model-value="activeSmartPreset ?? ''"
                :spacing="2"
                class="flex w-full flex-wrap"
                @update:model-value="
                  (value) =>
                    useRule(
                      smartPresets.find((item) => item.value === value)?.rules,
                    )
                "
              >
                <ToggleGroupItem
                  v-for="preset in smartPresets"
                  :key="preset.value"
                  :value="preset.value"
                  :data-selected="activeSmartPreset === preset.value"
                  variant="outline"
                  class="w-auto"
                >
                  {{ preset.label }}
                </ToggleGroupItem>
              </ToggleGroup>
              <p v-if="!activeSmartPreset" class="px-1 text-muted-foreground">
                当前为自定义智能规则
              </p>
            </div>

            <!-- 用户配置:分组标题与左侧栏一致(整行可折叠,箭头在右) + 固定高度滚动 -->
            <Collapsible v-if="mode === 'user'" v-model:open="presetsOpen" class="flex flex-col gap-2">
              <div class="flex w-full min-w-0 items-center gap-1">
                <CollapsibleTrigger as-child>
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 appearance-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold tracking-wide text-muted-foreground transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50"
                    style="border: 0"
                    :aria-expanded="presetsOpen"
                  >
                    <span class="min-w-0 flex-1 truncate">用户配置</span>
                    <span class="font-mono text-xs font-normal">{{ listedPresets.length }}</span>
                    <component :is="presetsOpen ? ChevronDown : ChevronRight" class="shrink-0" />
                  </button>
                </CollapsibleTrigger>
                <Button size="sm" class="shrink-0" @click="beginCreatePreset">
                  创建配置
                </Button>
              </div>
              <CollapsibleContent class="flex flex-col gap-2">
                <!-- 空态判断用 listedPresets:内置"默认规则"始终在列,不能被空态一起隐藏 -->
                <p v-if="!listedPresets.length" class="px-2 text-xs leading-5 text-muted-foreground">
                  点「创建配置」新建一份可复用的策略配置；配置数量不限。
                </p>
                <div v-else class="scrollbar-thin flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
                  <div
                    v-for="preset in listedPresets"
                    :key="preset.id"
                    class="flex items-center gap-2 rounded-md border p-2 shadow-xs"
                    :class="isPresetSelected(preset)
                      ? 'border-input bg-accent text-accent-foreground'
                      : 'border-input bg-transparent hover:bg-accent/50'"
                  >
                  <template v-if="renamingPreset?.id === preset.id">
                    <form class="flex min-w-0 flex-1 items-center gap-2" @submit.prevent="submitRenamePreset">
                      <Input
                        v-model="renamingPreset.name"
                        class="h-8"
                        :aria-label="`重命名 ${preset.name}`"
                        maxlength="60"
                        @keydown.esc="renamingPreset = null"
                      />
                      <Button size="sm" type="submit">保存</Button>
                      <Button size="sm" variant="ghost" @click="renamingPreset = null">取消</Button>
                    </form>
                  </template>
                  <template v-else>
                    <button
                      type="button"
                      class="min-w-0 flex-1 text-left"
                      :title="`选中「${preset.name}」`"
                      :aria-pressed="isPresetSelected(preset)"
                      @click="loadPreset(preset)"
                    >
                      <span class="flex items-center gap-1.5">
                        <span class="truncate text-sm">{{ preset.name }}</span>
                        <Badge v-if="preset.id === '__builtin_default__'" variant="outline">内置</Badge>
                      </span>
                      <span class="block truncate text-xs text-muted-foreground">
                        {{ preset.id === '__builtin_default__' ? '代码内置' : presetDate(preset.updated) }}
                        · {{ preset.rules.trim().length }} 字
                      </span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="ghost" size="icon-xs" :aria-label="`${preset.name} 的操作`">⋯</Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuGroup>
                          <DropdownMenuItem @select="editPreset(preset)">编辑</DropdownMenuItem>
                          <!-- 内置基线由代码定义,不可重命名/删除 -->
                          <template v-if="preset.id !== '__builtin_default__'">
                            <DropdownMenuItem @select="renamingPreset = { id: preset.id, name: preset.name }">重命名</DropdownMenuItem>
                            <DropdownMenuItem
                              :disabled="preset.id === activePresetId"
                              :title="preset.id === activePresetId ? '正在使用中，请先切换到其他配置' : undefined"
                              @select="preset.id === activePresetId ? undefined : (deletingPreset = preset)"
                            >删除</DropdownMenuItem>
                          </template>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </template>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

          </section>

          <section class="flex flex-col gap-3 pt-6">
            <Collapsible v-model:open="archivedOpen" class="flex min-w-0 flex-col gap-3">
            <div class="flex items-center justify-between gap-2">
              <div>
              <h3 class="text-sm font-semibold">归档团队</h3>
              <p class="mt-1 text-xs text-muted-foreground">
                归档团队不再接收消息；恢复后可继续沟通。
              </p>
              </div>
              <CollapsibleTrigger v-if="archivedTeams?.length" as-child>
                <Button variant="ghost" size="sm" :aria-label="archivedOpen ? '收起归档团队' : '展开归档团队'">
                  <span class="tabular-nums">{{ archivedTeams.length }}</span>
                  <ChevronDown v-if="archivedOpen" /><ChevronRight v-else />
                </Button>
              </CollapsibleTrigger>
            </div>
            <Empty v-if="!archivedTeams?.length">
              <EmptyHeader><EmptyTitle>没有归档团队</EmptyTitle></EmptyHeader>
            </Empty>
            <CollapsibleContent v-else>
            <div class="flex max-h-72 flex-col gap-2 overflow-y-auto overscroll-contain pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" role="region" aria-label="归档团队列表" tabindex="0">
              <div
                v-for="team in archivedTeams"
                :key="team.id"
                class="flex items-center gap-3 border p-3"
              >
                <span
                  class="grid size-8 shrink-0 place-items-center text-muted-foreground"
                >
                  <Archive />
                </span>
                <span class="min-w-0 flex-1">
                  <strong class="block truncate text-xs">{{
                    team.name
                  }}</strong>
                  <small
                    class="block truncate font-mono text-muted-foreground"
                    >{{ team.id }}</small
                  >
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  @click="emit('restoreTeam', team)"
                  >恢复</Button
                >
              </div>
            </div>
            </CollapsibleContent>
            </Collapsible>
          </section>

          <Alert v-if="error" variant="destructive">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>
        </CardContent>
      </component>
    </div>
    <Dialog
      :open="creatingPreset"
      @update:open="(value) => { if (!value) creatingPreset = false; }"
    >
      <DialogContent v-if="creatingPreset" class="max-w-2xl">
        <div class="flex flex-col gap-4">
          <div>
            <h3 class="text-sm font-semibold">创建配置</h3>
            <p class="mt-1 text-xs text-muted-foreground">
              新建一份可复用的模型策略配置；规则默认为空，请自行填写。
            </p>
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium" for="preset-name">配置名称</label>
            <Input
              id="preset-name"
              v-model="newPreset.name"
              placeholder="1-60 字符"
              maxlength="60"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between">
              <label class="text-xs font-medium" for="preset-rules">自然语言规则</label>
              <span class="font-mono text-xs text-muted-foreground">{{ newPreset.rules.trim().length }} 字</span>
            </div>
            <Textarea
              id="preset-rules"
              v-model="newPreset.rules"
              class="scrollbar-thin min-h-56 max-h-[45vh] overflow-y-auto"
              placeholder="填写这份配置的模型选择规则（不能为空）"
              spellcheck="false"
            />
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="sm" @click="creatingPreset = false">取消</Button>
            <Button size="sm" :disabled="!canCreatePreset" @click="submitCreatePreset">创建</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog
      :open="rulesDialog !== null"
      @update:open="(value) => { if (!value) rulesDialog = null; }"
    >
      <DialogContent v-if="rulesDialog" class="max-w-2xl">
        <div class="flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <div class="min-w-0 flex-1">
              <h3 class="truncate text-sm font-semibold">{{ rulesDialogTitle }}</h3>
              <p class="text-xs text-muted-foreground">
                {{ rulesDialog.preset ? '用户配置' : (mode === 'smart' ? '智能策略' : '用户配置') }}
                · {{ rulesDialogRules.trim().length }} 字
                <template v-if="rulesDialog.preset?.id === '__builtin_default__'"> · 内置</template>
              </p>
            </div>
            <Button v-if="rulesDialog.mode === 'view'" size="sm" variant="outline" @click="switchRulesDialogToEdit">编辑</Button>
          </div>
          <p
            v-if="rulesDialog.mode === 'view'"
            class="scrollbar-thin max-h-[55vh] overflow-y-auto whitespace-pre-wrap wrap-anywhere border p-3 text-sm leading-6"
          >{{ rulesDialogRules }}</p>
          <template v-else>
            <Textarea
              v-model="rulesDraft"
              aria-label="模型策略自然语言规则"
              class="scrollbar-thin min-h-64 max-h-[55vh] overflow-y-auto overscroll-contain"
              spellcheck="false"
            />
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-muted-foreground">{{ rulesDraft.trim().length }} 字</span>
              <div class="flex gap-2">
                <Button variant="ghost" size="sm" @click="rulesDialog = null">取消</Button>
                <Button size="sm" :disabled="!rulesDraft.trim()" @click="applyRulesDraft">确认</Button>
              </div>
            </div>
          </template>
          <div v-if="rulesDialog.mode === 'view'" class="flex justify-end gap-2">
            <Button variant="ghost" size="sm" @click="rulesDialog = null">关闭</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      :open="deletingPreset !== null"
      :title="`删除配置「${deletingPreset?.name ?? ''}」？`"
      description="删除后不可恢复。正在使用的配置不能删除，请先切换到其他配置。"
      confirm-text="删除"
      destructive
      @confirm="confirmDeletePreset"
      @cancel="deletingPreset = null"
    />
  </Dialog>
</template>
