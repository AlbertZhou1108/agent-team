<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Check,
  Monitor,
  Moon,
  Settings2,
  Sun,
  X,
} from '@lucide/vue';
import { api } from '@/shared/api/client';
import type {
  Group,
  ModelPolicyDefaults,
  TeamModelPolicy,
} from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { usePreferencesStore, type ThemePreference } from '@/stores/preferences';
import { cn } from '@/lib/utils';

const props = defineProps<{
  open: boolean;
  group?: Group;
  policy?: TeamModelPolicy;
  defaults?: ModelPolicyDefaults;
}>();

const emit = defineEmits<{
  close: [];
  saved: [policy: TeamModelPolicy];
}>();

const preferences = usePreferencesStore();
const mode = ref<TeamModelPolicy['mode']>('user');
const rules = ref('');
const saving = ref(false);
const error = ref('');

const themes: Array<{ value: ThemePreference; icon: typeof Sun; label: string }> = [
  { value: 'dark', icon: Moon, label: '深色' },
  { value: 'light', icon: Sun, label: '浅色' },
  { value: 'system', icon: Monitor, label: '跟随系统' },
];

const canSave = computed(() => Boolean(props.group && rules.value.trim() && !saving.value));
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

function selectMode(next: TeamModelPolicy['mode']) {
  if (mode.value === next) return;
  mode.value = next;
  rules.value = next === 'smart'
    ? props.defaults?.smart.cost ?? ''
    : props.defaults?.user ?? '';
}

function useRule(value?: string) {
  if (value) rules.value = value;
}

async function save() {
  if (!props.group || !canSave.value) return;
  saving.value = true;
  error.value = '';
  try {
    const policy = await api.updateModelPolicy(props.group.id, mode.value, rules.value);
    emit('saved', policy);
    emit('close');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open) emit('close');
}

watch(
  () => [props.open, props.policy?.mode, props.policy?.rules, props.defaults],
  () => {
    if (props.open) reset();
  },
  { immediate: true },
);

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4 backdrop-blur-sm"
      role="presentation"
      @click.self="emit('close')"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        class="panel max-h-[min(760px,calc(100vh-2rem))] w-full max-w-2xl overflow-hidden shadow-2xl"
      >
        <header class="flex items-center gap-3 border-b border-[var(--border)] px-5 py-4">
          <span class="grid size-9 place-items-center rounded-xl border border-[var(--primary-border)] bg-[var(--primary-muted)] text-[var(--primary)]">
            <Settings2 :size="17" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="eyebrow">SETTINGS</p>
            <h2 id="settings-title" class="mt-0.5 text-base font-semibold">设置</h2>
          </div>
          <Button variant="ghost" size="icon" title="关闭设置" @click="emit('close')">
            <X :size="16" />
          </Button>
        </header>

        <div class="max-h-[calc(100vh-9rem)] space-y-7 overflow-y-auto px-5 py-5">
          <section class="space-y-3">
            <div>
              <h3 class="text-sm font-semibold">主题</h3>
              <p class="mt-1 text-xs text-muted">主题偏好保存在当前浏览器。</p>
            </div>
            <div class="grid grid-cols-3 gap-2">
              <button
                v-for="item in themes"
                :key="item.value"
                type="button"
                :class="cn(
                  'relative flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-xs transition',
                  preferences.theme === item.value
                    ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--foreground)] ring-2 ring-[var(--ring)] ring-offset-2 ring-offset-[var(--surface)]'
                    : 'border-[var(--border)] bg-[var(--surface-raised)] text-muted hover:bg-[var(--surface-hover)]',
                )"
                @click="preferences.setTheme(item.value)"
              >
                <component :is="item.icon" :size="14" />
                <span class="flex-1">{{ item.label }}</span>
                <span
                  v-if="preferences.theme === item.value"
                  class="grid size-5 place-items-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)]"
                >
                  <Check :size="12" :stroke-width="3" />
                </span>
              </button>
            </div>
          </section>

          <section class="space-y-3 border-t border-[var(--border)] pt-6">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="text-sm font-semibold">模型策略</h3>
                <p class="mt-1 text-xs leading-5 text-muted">
                  仅影响当前团队之后新建的角色；已有角色模型不会被改写。
                </p>
              </div>
              <Button size="sm" class="shrink-0" :disabled="!canSave" @click="save">
                {{ saving ? '保存中…' : '保存模型策略' }}
              </Button>
            </div>

            <p v-if="!group" class="rounded-lg border border-dashed border-[var(--border)] p-4 text-xs text-muted">
              请先选择一个团队。
            </p>

            <template v-else>
              <div class="flex items-center justify-between gap-3">
                <span class="font-mono text-[10px] text-dim">{{ group.name }} · {{ group.id }}</span>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  :class="cn(
                    'flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs transition',
                    mode === 'smart'
                      ? 'border-[var(--primary)] bg-[var(--primary-muted)] ring-2 ring-[var(--ring)] ring-offset-2 ring-offset-[var(--surface)]'
                      : 'border-[var(--border)] bg-[var(--surface-raised)] hover:bg-[var(--surface-hover)]',
                  )"
                  @click="selectMode('smart')"
                >
                  <span class="flex-1 text-left font-medium">智能策略</span>
                  <span
                    :class="cn(
                      'grid size-5 place-items-center rounded-full border',
                      mode === 'smart'
                        ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]'
                        : 'border-[var(--border)] text-transparent',
                    )"
                  >
                    <Check :size="12" :stroke-width="3" />
                  </span>
                </button>
                <button
                  type="button"
                  :class="cn(
                    'flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs transition',
                    mode === 'user'
                      ? 'border-[var(--primary)] bg-[var(--primary-muted)] ring-2 ring-[var(--ring)] ring-offset-2 ring-offset-[var(--surface)]'
                      : 'border-[var(--border)] bg-[var(--surface-raised)] hover:bg-[var(--surface-hover)]',
                  )"
                  @click="selectMode('user')"
                >
                  <span class="flex-1 text-left font-medium">用户配置</span>
                  <span
                    :class="cn(
                      'grid size-5 place-items-center rounded-full border',
                      mode === 'user'
                        ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]'
                        : 'border-[var(--border)] text-transparent',
                    )"
                  >
                    <Check :size="12" :stroke-width="3" />
                  </span>
                </button>
              </div>

              <div v-if="mode === 'smart'" class="space-y-2">
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="preset in smartPresets"
                    :key="preset.value"
                    type="button"
                    :class="cn(
                      'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] transition',
                      activeSmartPreset === preset.value
                        ? 'border-[var(--primary)] bg-[var(--primary-muted)] font-medium text-[var(--foreground)]'
                        : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-hover)]',
                    )"
                    @click="useRule(preset.rules)"
                  >
                    <Check v-if="activeSmartPreset === preset.value" :size="11" :stroke-width="3" />
                    {{ preset.label }}
                  </button>
                </div>
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
                  class="min-h-52 w-full resize-y border-t border-[var(--border)] bg-[var(--surface)] p-3 text-xs leading-6 text-[var(--foreground)] outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--ring)]"
                  spellcheck="false"
                />
              </details>
            </template>
          </section>

          <p v-if="error" class="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-3 text-xs text-[var(--danger)]" role="alert">
            {{ error }}
          </p>
        </div>
      </section>
    </div>
  </Teleport>
</template>
