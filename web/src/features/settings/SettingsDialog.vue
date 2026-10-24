<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Archive,
  ArrowLeft,
  Monitor,
  Moon,
  Settings2,
  Sun,
} from '@lucide/vue';
import { api } from '@/shared/api/client';
import type {
  Group,
  ModelPolicy,
  ModelPolicyDefaults,
} from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
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
const mode = ref<ModelPolicy['mode']>('user');
const rules = ref('');
const saving = ref(false);
const error = ref('');
const rulesOpen = ref(false);

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
const hasPolicyChanges = computed(
  () =>
    mode.value !== originalMode.value ||
    rules.value.trim() !== originalRules.value.trim(),
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

function reset() {
  mode.value = props.policy?.mode ?? 'user';
  rules.value = props.policy?.rules ?? props.defaults?.user ?? '';
  error.value = '';
}

function selectMode(next: ModelPolicy['mode']) {
  if (mode.value === next) return;
  mode.value = next;
  rules.value =
    next === 'smart'
      ? (props.defaults?.smart.cost ?? '')
      : (props.defaults?.user ?? '');
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
  if (value) rules.value = value;
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = '';
  try {
    const policy = await api.updateModelPolicy(mode.value, rules.value);
    emit('saved', policy);
    if (!props.embedded) emit('close');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
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
          <span>
            <Settings2 />
          </span>
          <div class="min-w-0 flex-1">
            <h1 v-if="embedded" class="text-2xl font-semibold">设置</h1>
            <DialogTitle v-else>设置</DialogTitle>
          </div>
        </CardHeader>

        <CardContent class="min-h-0 flex-1 overflow-y-auto flex flex-col gap-6">
          <section class="flex flex-col gap-3">
            <div>
              <h3 class="text-sm font-semibold">显示模式</h3>
              <p class="mt-1 text-xs text-muted-foreground">
                控制界面的明暗外观，保存在当前浏览器。
              </p>
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



          <section class="flex flex-col gap-3 pt-6">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="text-sm font-semibold">模型策略</h3>
                <p class="mt-1 text-xs leading-5 text-muted-foreground">
                  全局策略在创建新团队和已有团队新增角色时读取；已有角色模型不会被改写。
                </p>
              </div>
              <Button
                v-if="hasPolicyChanges"
                size="sm"
                class="shrink-0"
                :disabled="!canSave"
                @click="save"
              >
                {{ saving ? '保存中…' : '保存' }}
              </Button>
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

            <Collapsible v-model:open="rulesOpen" class="flex flex-col gap-2">
              <CollapsibleTrigger as-child
                ><Button variant="outline" class="w-full justify-between">
                  <span class="flex-1 text-left">自然语言规则</span>
                  <span class="font-mono text-muted-foreground"
                    >{{ rules.trim().length }} 字</span
                  >
                  <span class="text-muted-foreground">{{ rulesOpen ? '收起编辑' : '展开编辑' }}</span>
                </Button></CollapsibleTrigger
              >
              <CollapsibleContent>
                <Textarea
                  v-model="rules"
                  aria-label="模型策略自然语言规则"
                  class="min-h-64 max-h-[42vh] overflow-y-auto overscroll-contain"
                  spellcheck="false"
                  @wheel.stop
                />
              </CollapsibleContent>
            </Collapsible>
          </section>

          <section class="flex flex-col gap-3 pt-6">
            <div>
              <h3 class="text-sm font-semibold">归档团队</h3>
              <p class="mt-1 text-xs text-muted-foreground">
                归档团队不再接收消息；恢复后可继续沟通。
              </p>
            </div>
            <Empty v-if="!archivedTeams?.length">
              <EmptyHeader><EmptyTitle>没有归档团队</EmptyTitle></EmptyHeader>
            </Empty>
            <div v-else class="flex flex-col gap-2">
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
          </section>

          <Alert v-if="error" variant="destructive">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>
        </CardContent>
      </component>
    </div>
  </Dialog>
</template>
