<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Archive,
  ArrowLeft,
  Monitor,
  Moon,
  Settings2,
  Sun,
  X,
} from '@lucide/vue';
import { api } from '@/shared/api/client';
import type {
  Group,
  ModelPolicy,
  ModelPolicyDefaults,
} from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  usePreferencesStore,
  type ColorMode,
  type ColorTheme,
} from '@/stores/preferences';

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

const colorModes: Array<{ value: ColorMode; icon: typeof Sun; label: string }> = [
  { value: 'dark', icon: Moon, label: '深色' },
  { value: 'light', icon: Sun, label: '浅色' },
  { value: 'system', icon: Monitor, label: '跟随系统' },
];
const colorThemes: Array<{ value: ColorTheme; label: string; description: string }> = [
  { value: 'mist', label: '雾灰', description: '比石墨更浅的柔和中性灰' },
  { value: 'neutral', label: '石墨', description: '克制的中性灰阶' },
  { value: 'ocean', label: '深海蓝', description: '清晰、专注的深海蓝色' },
  { value: 'forest', label: '森林', description: '柔和、稳定的绿色' },
  { value: 'rose', label: '玫瑰', description: '温暖而有辨识度的红色' },
  { value: 'amber', label: '琥珀', description: '明快的橙金色' },
];

const originalMode = computed(() => props.policy?.mode ?? 'user');
const originalRules = computed(() => (
  props.policy?.rules ?? props.defaults?.user ?? ''
));
const hasPolicyChanges = computed(() => (
  mode.value !== originalMode.value
  || rules.value.trim() !== originalRules.value.trim()
));
const canSave = computed(() => Boolean(
  rules.value.trim() && hasPolicyChanges.value && !saving.value,
));
const activeColorTheme = computed(() => (
  colorThemes.find(item => item.value === preferences.colorTheme) ?? colorThemes[0]
));
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
const activeSmartPreset = computed(() => (
  mode.value === 'smart'
    ? smartPresets.value.find(item => item.rules && item.rules.trim() === rules.value.trim())?.value ?? null
    : null
));

function reset() {
  mode.value = props.policy?.mode ?? 'user';
  rules.value = props.policy?.rules ?? props.defaults?.user ?? '';
  error.value = '';
}

function selectMode(next: ModelPolicy['mode']) {
  if (mode.value === next) return;
  mode.value = next;
  rules.value = next === 'smart'
    ? props.defaults?.smart.cost ?? ''
    : props.defaults?.user ?? '';
}

function selectPolicyMode(value: unknown) {
  if (value === 'smart' || value === 'user') selectMode(value);
}

function selectColorMode(value: unknown) {
  if (value === 'dark' || value === 'light' || value === 'system') {
    preferences.setColorMode(value);
  }
}

function selectColorTheme(value: unknown) {
  if (colorThemes.some(item => item.value === value)) {
    preferences.setColorTheme(value as ColorTheme);
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

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open && !props.embedded) emit('close');
}

watch(
  () => [props.open, props.embedded, props.policy?.mode, props.policy?.rules, props.defaults],
  () => {
    if (props.open || props.embedded) reset();
  },
  { immediate: true },
);

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body" :disabled="embedded">
    <div
      v-if="open || embedded"
      :class="embedded
        ? 'settings-page'
        : 'fixed inset-0 z-50 grid place-items-center bg-black/45 p-4 backdrop-blur-sm'"
      :role="embedded ? undefined : 'presentation'"
      @click.self="!embedded && emit('close')"
    >
      <section
        :role="embedded ? undefined : 'dialog'"
        :aria-modal="embedded ? undefined : 'true'"
        aria-labelledby="settings-title"
        :class="embedded
          ? 'settings-page-panel panel'
          : 'panel flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden shadow-2xl'"
      >
        <header class="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-5 py-4">
          <Button
            v-if="embedded"
            variant="ghost"
            size="icon"
            title="返回"
            aria-label="返回"
            @click="emit('close')"
          >
            <ArrowLeft :size="16" />
          </Button>
          <span class="grid size-9 place-items-center rounded-xl border border-[var(--primary-border)] bg-[var(--primary-muted)] text-[var(--primary)]">
            <Settings2 :size="17" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="eyebrow">SETTINGS</p>
            <h2 id="settings-title" class="mt-0.5 text-base font-semibold">设置</h2>
          </div>
          <Button
            v-if="!embedded"
            variant="ghost"
            size="icon"
            title="关闭设置"
            aria-label="关闭设置"
            @click="emit('close')"
          >
            <X :size="16" />
          </Button>
        </header>

        <div class="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section class="flex flex-col gap-3">
            <div>
              <h3 class="text-sm font-semibold">显示模式</h3>
              <p class="mt-1 text-xs text-muted">控制界面的明暗外观，保存在当前浏览器。</p>
            </div>
            <ToggleGroup
              type="single"
              :model-value="preferences.colorMode"
              :spacing="2"
              class="display-mode-group grid w-full grid-cols-3 gap-2"
              @update:model-value="selectColorMode"
            >
              <ToggleGroupItem
                v-for="item in colorModes"
                :key="item.value"
                :value="item.value"
                :data-selected="preferences.colorMode === item.value"
                variant="outline"
                class="display-mode-option h-auto min-w-0 justify-start gap-2 rounded-xl px-3 py-2.5"
              >
                <component :is="item.icon" :size="14" />
                <span class="flex-1">{{ item.label }}</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </section>

          <section class="flex flex-col gap-3 border-t border-[var(--border)] pt-6">
            <div>
              <h3 class="text-sm font-semibold">主题色</h3>
              <p class="mt-1 text-xs text-muted">主题色与明暗模式相互独立，可自由组合。</p>
            </div>
            <ToggleGroup
              type="single"
              :model-value="preferences.colorTheme"
              :spacing="2"
              class="theme-color-group grid w-full grid-cols-3 gap-2 sm:grid-cols-6"
              @update:model-value="selectColorTheme"
            >
              <ToggleGroupItem
                v-for="item in colorThemes"
                :key="item.value"
                :value="item.value"
                :data-selected="preferences.colorTheme === item.value"
                variant="outline"
                class="theme-color-option h-auto min-w-0 flex-col gap-1.5 rounded-xl px-1.5 py-2.5"
                :title="item.description"
              >
                <span
                  class="theme-color-swatch"
                  :data-theme-swatch="item.value"
                  aria-hidden="true"
                />
                <span class="text-[11px]">{{ item.label }}</span>
              </ToggleGroupItem>
            </ToggleGroup>
            <p class="text-[11px] text-muted">{{ activeColorTheme.description }}</p>
          </section>

          <section class="flex flex-col gap-3 border-t border-[var(--border)] pt-6">
            <div>
              <h3 class="text-sm font-semibold">归档团队</h3>
              <p class="mt-1 text-xs text-muted">归档团队不接收消息，也不启动 Goal；恢复后继续使用原队列。</p>
            </div>
            <p v-if="!archivedTeams?.length" class="rounded-lg border border-dashed p-3 text-xs text-muted">
              没有归档团队。
            </p>
            <div v-else class="flex flex-col gap-2">
              <div
                v-for="team in archivedTeams"
                :key="team.id"
                class="flex items-center gap-3 rounded-xl border bg-[var(--surface-raised)] p-3"
              >
                <span class="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <Archive />
                </span>
                <span class="min-w-0 flex-1">
                  <strong class="block truncate text-xs">{{ team.name }}</strong>
                  <small class="block truncate font-mono text-[10px] text-dim">{{ team.id }}</small>
                </span>
                <Button variant="outline" size="sm" @click="emit('restoreTeam', team)">恢复</Button>
              </div>
            </div>
          </section>

          <section class="space-y-3 border-t border-[var(--border)] pt-6">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="text-sm font-semibold">模型策略</h3>
                <p class="mt-1 text-xs leading-5 text-muted">
                  全局策略在创建新团队和已有团队新增角色时读取；已有角色模型不会被改写。
                </p>
              </div>
              <Button v-if="hasPolicyChanges" size="sm" class="shrink-0" :disabled="!canSave" @click="save">
                {{ saving ? '保存中…' : '保存' }}
              </Button>
            </div>

            <ToggleGroup
              type="single"
              :model-value="mode"
              :spacing="2"
              class="grid w-full grid-cols-2 gap-2"
              @update:model-value="selectPolicyMode"
            >
              <ToggleGroupItem
                value="smart"
                variant="outline"
                :data-selected="mode === 'smart'"
                class="h-auto min-w-0 justify-start rounded-xl px-3 py-2.5"
              >
                <span class="flex-1 text-left font-medium">智能策略</span>
              </ToggleGroupItem>
              <ToggleGroupItem
                value="user"
                variant="outline"
                :data-selected="mode === 'user'"
                class="h-auto min-w-0 justify-start rounded-xl px-3 py-2.5"
              >
                <span class="flex-1 text-left font-medium">用户配置</span>
              </ToggleGroupItem>
            </ToggleGroup>

            <div v-if="mode === 'smart'" class="space-y-2">
              <ToggleGroup
                type="single"
                :model-value="activeSmartPreset ?? ''"
                :spacing="2"
                class="flex w-full flex-wrap gap-2"
                @update:model-value="value => useRule(smartPresets.find(item => item.value === value)?.rules)"
              >
                <ToggleGroupItem
                  v-for="preset in smartPresets"
                  :key="preset.value"
                  :value="preset.value"
                  :data-selected="activeSmartPreset === preset.value"
                  variant="outline"
                  class="w-auto h-auto rounded-lg px-2.5 py-1.5 text-[11px]"
                >
                  {{ preset.label }}
                </ToggleGroupItem>
              </ToggleGroup>
              <p v-if="!activeSmartPreset" class="px-1 text-[10px] text-muted">
                当前为自定义智能规则
              </p>
            </div>

            <details class="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)]">
              <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-xs">
                <span class="flex-1 font-medium">自然语言规则</span>
                <span class="font-mono text-[10px] text-dim">{{ rules.trim().length }} 字</span>
                <span class="text-[10px] text-muted">展开编辑</span>
              </summary>
              <textarea
                v-model="rules"
                class="block h-64 max-h-[42vh] w-full resize-none overflow-y-scroll overscroll-contain border-t border-[var(--border)] bg-[var(--surface)] p-3 text-xs leading-6 text-[var(--foreground)] outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--ring)]"
                spellcheck="false"
                @wheel.stop
              />
            </details>
          </section>

          <p v-if="error" class="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-3 text-xs text-[var(--danger)]" role="alert">
            {{ error }}
          </p>
        </div>
      </section>
    </div>
  </Teleport>
</template>
