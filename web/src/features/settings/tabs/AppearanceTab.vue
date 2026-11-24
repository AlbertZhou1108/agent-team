<script setup lang="ts">
import { computed, ref } from 'vue';
import { Disclosure } from '@/components/ui/disclosure';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ChevronLeft, ChevronRight, Download, Monitor, Moon, Sun, Trash2, Upload } from '@lucide/vue';
import AppearanceSample from '../AppearanceSample.vue';
import { usePreferencesStore, type ColorMode } from '@/stores/preferences';
import { isMotionPreference, type MotionPreference } from '@/shared/motion';
import { isCodeSize, isDensity, isMaterialPreference, isReadingLeading, isReadingSize, isReadingWidth, type MaterialPreference } from '@/theme/apply';
import { DESIGN_PRESETS, isDesignPresetId, isPresetModified, type DesignPresetId } from '@/theme/design-presets';
import { MATERIAL_CATEGORIES } from '@/theme/materials';
import { CLASSIC_THEME_ID } from '@/theme/builtin';
import { useThemePacks } from '../use-theme-packs';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FileDropzone } from '@/components/ui/file-dropzone';
import { Alert, AlertDescription } from '@/components/ui/alert';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { SectionBlock } from '@/components/panel';

const preferences = usePreferencesStore();
const sampleOpen = ref(false);

const PRESET_DESCRIPTIONS: Record<DesignPresetId, string> = {
  classic: '纯黑碳灰 · 静谧工具面',
  'frosted-glass': '半透明微光材质 · 柔化边界',
  paper: '暖纸哑光肌理 · 柔和炭灰阅读',
  vivid: '明快强调色 · 大圆角高区分度',
};

const presetList = Object.values(DESIGN_PRESETS).map((preset) => ({
  ...preset,
  description: PRESET_DESCRIPTIONS[preset.id as DesignPresetId] ?? '',
}));

const colorModes: Array<{ value: ColorMode; icon: typeof Sun; label: string }> = [
  { value: 'light', icon: Sun, label: '浅色' },
  { value: 'dark', icon: Moon, label: '深色' },
  { value: 'system', icon: Monitor, label: '跟随系统' },
];

const motionOptions: Array<{ value: MotionPreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'simple', label: '简洁' },
  { value: 'soft', label: '柔和' },
  { value: 'lively', label: '灵动' },
  { value: 'reduced', label: '减少' },
];

const materialOptions = Object.values(MATERIAL_CATEGORIES).map((category) => ({
  value: category.id as MaterialPreference,
  label: category.label,
}));

// 预设选中态与各轴取值会因逐项调整而漂移,标记出来保住预设入口的可信度。
const presetModified = computed(() => isPresetModified(preferences.designPreset, {
  colorMode: preferences.colorMode,
  themePack: preferences.themePack,
  materialPreference: preferences.materialPreference,
  motionPreference: preferences.motionPreference,
  density: preferences.density,
}));

const densityOptions: Array<{ value: 'compact' | 'standard' | 'loose'; label: string }> = [
  { value: 'compact', label: '紧凑' },
  { value: 'standard', label: '标准' },
  { value: 'loose', label: '宽松' },
];

const readingSizeOptions: Array<{ value: 'standard' | 'large' | 'xlarge'; label: string }> = [
  { value: 'standard', label: '标准' },
  { value: 'large', label: '大' },
  { value: 'xlarge', label: '特大' },
];

const readingLeadingOptions: Array<{ value: 'standard' | 'relaxed'; label: string }> = [
  { value: 'standard', label: '标准' },
  { value: 'relaxed', label: '宽松' },
];

const readingWidthOptions: Array<{ value: 'standard' | 'wide' | 'full'; label: string }> = [
  { value: 'standard', label: '标准' },
  { value: 'wide', label: '宽' },
  { value: 'full', label: '全宽' },
];

const codeSizeOptions: Array<{ value: 'standard' | 'large'; label: string }> = [
  { value: 'standard', label: '标准' },
  { value: 'large', label: '大' },
];

// ===== 外观设置:所有选项点击即写入偏好并立即生效(2026-10-31 用户决策,取消预览+应用确认) =====
// 阅读独立于外观,不参与恢复默认;恢复默认重置明暗/主题/材质/动效/密度五维。
const APPEARANCE_DEFAULTS = {
  colorMode: 'system' as const,
  themePack: CLASSIC_THEME_ID,
  materialPreference: 'solid' as const,
  motionPreference: 'system' as const,
  density: 'standard' as const,
};

function restoreAppearanceDefaults() {
  preferences.setDesignPreset('classic', false);
  preferences.setColorMode(APPEARANCE_DEFAULTS.colorMode);
  const classic = allThemePacks.value.find((item) => item.id === CLASSIC_THEME_ID);
  preferences.setThemePack(
    CLASSIC_THEME_ID,
    classic ? { light: classic.light, dark: classic.dark } : null,
  );
  preferences.setMaterialPreference(APPEARANCE_DEFAULTS.materialPreference);
  preferences.setMotionPreference(APPEARANCE_DEFAULTS.motionPreference);
  preferences.setDensity(APPEARANCE_DEFAULTS.density);
}

// ===== 主题包：实现见 use-theme-packs.ts =====
const {
  allThemePacks, themeOpen, isBuiltinTheme, selectTheme, themeSwatches,
  themeTrack, canScrollThemeLeft, canScrollThemeRight, updateThemeCarousel, scrollThemeTrack,
  addThemeOpen, addThemeError, uploadingTheme, beginAddTheme, downloadThemeTemplate, onThemeFiles,
  deletingTheme, requestDeleteTheme, confirmDeleteTheme,
} = useThemePacks();

function applyPreset(id: string) {
  if (isDesignPresetId(id)) preferences.setDesignPreset(id);
}

function selectColorMode(value: unknown) {
  if (value === 'dark' || value === 'light' || value === 'system') {
    preferences.setColorMode(value);
  }
}

function selectMotionPreference(value: unknown) {
  if (isMotionPreference(value)) {
    preferences.setMotionPreference(value);
  }
}

function selectMaterialPreference(value: unknown) {
  if (isMaterialPreference(value)) {
    preferences.setMaterialPreference(value);
  }
}

function selectDensity(value: unknown) {
  if (isDensity(value)) {
    preferences.setDensity(value);
  }
}

function selectReadingSize(value: unknown) {
  if (isReadingSize(value)) {
    preferences.setReading({ readingSize: value });
  }
}

function selectReadingLeading(value: unknown) {
  if (isReadingLeading(value)) {
    preferences.setReading({ readingLeading: value });
  }
}

function selectReadingWidth(value: unknown) {
  if (isReadingWidth(value)) {
    preferences.setReading({ readingWidth: value });
  }
}

function selectCodeSize(value: unknown) {
  if (isCodeSize(value)) {
    preferences.setReading({ codeSize: value });
  }
}
</script>

<template>
  <!-- 标题栏与视觉预设画廊（P07） -->
  <section class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <h2 class="text-lg font-semibold tracking-tight text-foreground">外观</h2>
        <Badge v-if="presetModified" variant="secondary" size="xs">已自定义</Badge>
      </div>
      <Button variant="outline" size="sm" @click="restoreAppearanceDefaults">恢复默认</Button>
    </div>

    <div
      class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      role="radiogroup"
      aria-label="设计预设"
    >
      <button
        v-for="preset in presetList"
        :key="preset.id"
        type="button"
        role="radio"
        :aria-checked="preferences.designPreset === preset.id"
        class="preset-gallery-card flex min-w-0 flex-col gap-2 rounded-(--component-control-radius) border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="preferences.designPreset === preset.id
          ? 'border-info bg-secondary/70'
          : 'border-border bg-secondary/30 hover:bg-secondary/55'"
        @click="applyPreset(preset.id)"
      >
        <span class="preset-thumb" :data-preset-thumb="preset.id" aria-hidden="true">
          <span class="preset-thumb-l0" />
          <span class="preset-thumb-l1" />
          <span class="preset-thumb-l0b" />
        </span>
        <span class="flex items-center justify-between gap-1.5">
          <span
            class="truncate text-sm font-medium"
            :class="preferences.designPreset === preset.id ? 'text-info' : 'text-foreground'"
          >{{ preset.label }}</span>
          <span
            v-if="preferences.designPreset === preset.id"
            class="shrink-0 text-2xs text-info"
          >当前</span>
        </span>
        <span class="truncate text-xs text-muted-foreground">{{ preset.description }}</span>
      </button>
    </div>
  </section>

  <!-- 紧凑「左标签 + 右分段控件」五维外观表单（P07） -->
  <SectionBlock size="md" class="gap-0 p-0">
    <div class="divide-y divide-border/70">
      <div class="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <h3 class="text-sm font-medium text-foreground">显示模式</h3>
          <p class="text-xs text-muted-foreground">浅色、深色或跟随系统</p>
        </div>
        <ToggleGroup
          presentation="segmented"
          type="single"
          :model-value="preferences.colorMode"
          :spacing="2"
          class="grid shrink-0 grid-cols-3"
          aria-label="显示模式"
          @update:model-value="selectColorMode"
        >
          <ToggleGroupItem
            v-for="item in colorModes"
            :key="item.value"
            :value="item.value"
            variant="outline"
            size="sm"
            class="min-w-0 gap-1.5 px-2.5 text-xs"
          >
            <component :is="item.icon" class="size-3.5" />
            <span>{{ item.label }}</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div class="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <h3 class="text-sm font-medium text-foreground">表面材质</h3>
          <p class="text-xs text-muted-foreground">控制面板与工作区的表面质感，效果不可用时自动回落</p>
        </div>
        <ToggleGroup
          presentation="segmented"
          type="single"
          :model-value="preferences.materialPreference"
          :spacing="2"
          class="grid shrink-0 grid-cols-4"
          aria-label="表面材质"
          @update:model-value="selectMaterialPreference"
        >
          <ToggleGroupItem
            v-for="item in materialOptions"
            :key="item.value"
            :value="item.value"
            variant="outline"
            size="sm"
            class="min-w-0 px-2.5 text-xs"
          >
            <span>{{ item.label }}</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div class="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <h3 class="text-sm font-medium text-foreground">动效节奏</h3>
          <p class="text-xs text-muted-foreground">弹窗、折叠与侧栏过渡节奏；明确选择后优先于系统偏好</p>
        </div>
        <ToggleGroup
          presentation="segmented"
          type="single"
          :model-value="preferences.motionPreference"
          :spacing="2"
          class="grid shrink-0 grid-cols-3 sm:grid-cols-5"
          aria-label="动效节奏"
          @update:model-value="selectMotionPreference"
        >
          <ToggleGroupItem
            v-for="item in motionOptions"
            :key="item.value"
            :value="item.value"
            variant="outline"
            size="sm"
            class="min-w-0 px-2 text-xs"
          >
            <span>{{ item.label }}</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div class="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <h3 class="text-sm font-medium text-foreground">界面密度</h3>
          <p class="text-xs text-muted-foreground">调整会话区与列表行距留白，不改变正文大小</p>
        </div>
        <ToggleGroup
          presentation="segmented"
          type="single"
          :model-value="preferences.density"
          :spacing="2"
          class="grid shrink-0 grid-cols-3"
          aria-label="界面密度"
          @update:model-value="selectDensity"
        >
          <ToggleGroupItem
            v-for="item in densityOptions"
            :key="item.value"
            :value="item.value"
            variant="outline"
            size="sm"
            class="min-w-0 px-3 text-xs"
          >
            <span>{{ item.label }}</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  </SectionBlock>

  <!-- 配色主题画廊（支持内置与自定义主题 JSON 上传） -->
  <section class="flex flex-col gap-3">
    <Disclosure :heading-level="3" v-model:open="themeOpen">
      <template #summary><span>配色主题</span><Badge>{{ allThemePacks.length }}</Badge></template>
      <template #description>点击色卡即切换，与深浅模式组合生效；自定义主题删除后可重新上传。</template>
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            :disabled="!canScrollThemeLeft"
            aria-label="向左滚动主题"
            @click="scrollThemeTrack(-1)"
          >
            <ChevronLeft />
          </Button>
          <div
            ref="themeTrack"
            class="scrollbar-thin flex min-w-0 flex-1 items-stretch gap-2 overflow-x-auto pb-1"
            @scroll.passive="updateThemeCarousel"
          >
            <div
              v-for="pack in allThemePacks"
              :key="pack.id"
              class="flex w-36 shrink-0 flex-col gap-1.5 rounded-(--component-control-radius) border p-2 transition-colors"
              :class="preferences.themePack === pack.id
                ? 'border-info bg-accent text-accent-foreground'
                : 'border-input bg-transparent hover:bg-(--state-hover)'"
            >
              <button
                type="button"
                class="flex appearance-none text-left"
                :aria-pressed="preferences.themePack === pack.id"
                :title="`使用「${pack.name}」`"
                @click="selectTheme(pack)"
              >
                <span class="flex flex-1 overflow-hidden rounded-(--component-chip-radius) border border-border">
                  <span
                    v-for="swatch in themeSwatches(pack)"
                    :key="swatch.key"
                    class="h-8 flex-1"
                    :class="swatch.divider ? 'border-r border-border' : ''"
                    :style="{ background: swatch.value }"
                  />
                </span>
              </button>
              <div class="flex min-w-0 items-center justify-between gap-1">
                <button
                  type="button"
                  class="min-w-0 flex-1 truncate text-left text-sm"
                  :title="`使用「${pack.name}」`"
                  @click="selectTheme(pack)"
                >
                  {{ pack.name }}
                </button>
                <Button
                  v-if="!isBuiltinTheme(pack)"
                  variant="ghost"
                  size="icon-xs"
                  :disabled="preferences.themePack === pack.id"
                  :title="preferences.themePack === pack.id ? '正在使用中，请先切换到其他主题' : `删除「${pack.name}」`"
                  :aria-label="`删除主题 ${pack.name}`"
                  @click="requestDeleteTheme(pack)"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <button
              type="button"
              class="flex w-36 shrink-0 flex-col items-center justify-center gap-1 rounded-(--component-control-radius) border border-dashed p-2 text-muted-foreground transition-colors outline-none hover:bg-(--state-hover) focus-visible:ring-2 focus-visible:ring-ring/50"
              @click="beginAddTheme"
            >
              <Upload class="size-4" />
              <span class="text-sm">新增主题</span>
            </button>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            :disabled="!canScrollThemeRight"
            aria-label="向右滚动主题"
            @click="scrollThemeTrack(1)"
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </Disclosure>
  </section>

  <!-- 独立阅读偏好（不受切换预设与恢复默认影响） -->
  <SectionBlock size="md" :heading-level="3" title="阅读偏好（独立保存）" description="只作用于会话正文与 Markdown 内容，不随切换设计预设或恢复默认被重置。">
    <div class="grid w-full gap-4 sm:grid-cols-2">
      <div
        v-for="group in [
          { label: '字号', value: preferences.readingSize, options: readingSizeOptions, select: selectReadingSize },
          { label: '行距', value: preferences.readingLeading, options: readingLeadingOptions, select: selectReadingLeading },
          { label: '内容宽度', value: preferences.readingWidth, options: readingWidthOptions, select: selectReadingWidth },
          { label: '代码字号', value: preferences.codeSize, options: codeSizeOptions, select: selectCodeSize },
        ]"
        :key="group.label"
        class="flex flex-col gap-1.5"
      >
        <p class="text-xs text-muted-foreground">{{ group.label }}</p>
        <ToggleGroup
          presentation="segmented"
          type="single"
          :model-value="group.value"
          :spacing="2"
          class="grid w-full"
          :class="group.options.length > 2 ? 'grid-cols-3' : 'grid-cols-2'"
          @update:model-value="group.select"
        >
          <ToggleGroupItem
            v-for="item in group.options"
            :key="item.value"
            :value="item.value"
            variant="outline"
            size="sm"
            class="min-w-0 px-1 text-xs"
          >
            <span>{{ item.label }}</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  </SectionBlock>

  <!-- 按需展开的组件实时样例预览（默认收起，保持设置页紧凑） -->
  <section class="flex flex-col gap-3">
    <Disclosure :heading-level="3" v-model:open="sampleOpen">
      <template #summary><span>组件实时预览</span></template>
      <AppearanceSample />
    </Disclosure>
  </section>

  <Dialog
    :open="addThemeOpen"
    @update:open="(value) => { if (!value) addThemeOpen = false; }"
  >
    <DialogContent v-if="addThemeOpen" class="max-w-lg">
      <div class="flex flex-col gap-4">
        <div>
          <h3 class="text-sm font-semibold">新增主题</h3>
          <p class="mt-1 text-xs text-muted-foreground">
            下载样板 JSON 填写颜色后上传；主题不提供在线修改，调整时删除后重新上传即可。
          </p>
        </div>
        <div class="flex flex-col gap-2">
          <Button variant="outline" size="sm" class="self-start" @click="downloadThemeTemplate">
            <Download />
            下载样板 JSON
          </Button>
          <FileDropzone
            accept=".json,application/json"
            :disabled="uploadingTheme"
            :label="uploadingTheme ? '导入中…' : '拖入主题 JSON 文件，或点击选择'"
            hint="支持带 // 注释的样板文件"
            @files="onThemeFiles"
          />
        </div>
        <Alert v-if="addThemeError" variant="destructive">
          <AlertDescription>{{ addThemeError }}</AlertDescription>
        </Alert>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="addThemeOpen = false">关闭</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
  <ConfirmDialog
    :open="deletingTheme !== null"
    :title="`删除主题「${deletingTheme?.name ?? ''}」？`"
    description="删除后不可恢复。正在使用该主题的设备会自动回落到内置主题。"
    confirm-text="删除"
    destructive
    @confirm="confirmDeleteTheme"
    @cancel="deletingTheme = null"
  />
</template>
