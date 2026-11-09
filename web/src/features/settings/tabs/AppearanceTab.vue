<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ChevronLeft, ChevronRight, Monitor, Moon, Sun, Trash, Upload } from '@lucide/vue';
import AppearanceSample from '../AppearanceSample.vue';
import { usePreferencesStore, type ColorMode } from '@/stores/preferences';
import { isMotionPreference, type MotionPreference } from '@/shared/motion';
import { isCodeSize, isDensity, isMaterialPreference, isReadingLeading, isReadingSize, isReadingWidth } from '@/theme/apply';
import { DESIGN_PRESETS, isDesignPresetId } from '@/theme/design-presets';
import { MATERIAL_CATEGORIES } from '@/theme/materials';
import { CLASSIC_THEME_ID } from '@/theme/builtin';
import { useThemePacks } from '../use-theme-packs';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FileDropzone } from '@/components/ui/file-dropzone';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Download } from '@lucide/vue';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';

const preferences = usePreferencesStore();

const colorModes: Array<{ value: ColorMode; icon: typeof Sun; label: string }> =
  [
    { value: 'system', icon: Monitor, label: '跟随系统' },
    { value: 'light', icon: Sun, label: '浅色' },
    { value: 'dark', icon: Moon, label: '深色' },
  ];

const motionOptions: Array<{ value: MotionPreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'reduced', label: '减少动态效果' },
  { value: 'simple', label: '简洁' },
  { value: 'soft', label: '柔和' },
  { value: 'lively', label: '灵动' },
];

const materialOptions = Object.values(MATERIAL_CATEGORIES).map((category) => ({
  value: category.id as 'solid' | 'glass',
  label: category.label,
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

// 主题色板跟随当前明暗模式。

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
          <section class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="text-sm font-semibold">设计预设</h3>
              <Button variant="outline" size="sm" @click="restoreAppearanceDefaults">恢复默认</Button>
            </div>
            <ToggleGroup presentation="segmented" type="single" :model-value="preferences.designPreset" variant="outline" aria-label="设计预设" @update:model-value="value => { if (isDesignPresetId(value)) preferences.setDesignPreset(value); }">
              <ToggleGroupItem v-for="preset in DESIGN_PRESETS" :key="preset.id" :value="preset.id">{{ preset.label }}</ToggleGroupItem>
            </ToggleGroup>
            <p class="text-xs text-muted-foreground">选择预设后仍可单独调整配色、材质、动效和密度，保留你的阅读设置；恢复默认回到出厂外观基线（不含阅读）。</p>
          </section>
          <AppearanceSample />

          <section class="flex flex-col gap-3">
            <div>
              <h3 class="text-sm font-semibold">显示模式</h3>
            </div>
            <ToggleGroup presentation="segmented"
              type="single"
              :model-value="preferences.colorMode"
              :spacing="2"
              class="display-mode-group grid w-full grid-cols-1 sm:grid-cols-3"
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
            <div>
              <h3 class="text-sm font-semibold">动效</h3>
              <p class="mt-1 text-xs text-muted-foreground">
                作用于弹窗、下拉、折叠与加载动画的节奏；跟随系统时响应系统偏好，明确选择后以应用内为准。
              </p>
            </div>
            <ToggleGroup presentation="segmented"
              type="single"
              :model-value="preferences.motionPreference"
              :spacing="2"
              class="grid w-full grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
              @update:model-value="selectMotionPreference"
            >
              <ToggleGroupItem
                v-for="item in motionOptions"
                :key="item.value"
                :value="item.value"
                variant="outline"
                class="min-w-0 px-1 text-xs"
              >
                <span>{{ item.label }}</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </section>

          <section class="flex flex-col gap-3">
            <div>
              <h3 class="text-sm font-semibold">材质</h3>
              <p class="mt-1 text-xs text-muted-foreground">
                玻璃作用于导航、上下文面板、会话操作区与菜单弹窗；阅读区保持实色，效果不可用时自动回落。圆角与按压触感随材质内化，不随预设改变。
              </p>
            </div>
            <ToggleGroup presentation="segmented"
              type="single"
              :model-value="preferences.materialPreference"
              :spacing="2"
              class="grid w-full grid-cols-4"
              @update:model-value="selectMaterialPreference"
            >
              <ToggleGroupItem
                v-for="item in materialOptions"
                :key="item.value"
                :value="item.value"
                variant="outline"
                class="min-w-0 text-xs"
              >
                <span>{{ item.label }}</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </section>

          <section class="flex flex-col gap-3">
            <div>
              <h3 class="text-sm font-semibold">密度</h3>
              <p class="mt-1 text-xs text-muted-foreground">调整会话区与列表的间距留白（见顶部样例），不改变正文大小。</p>
            </div>
            <ToggleGroup presentation="segmented"
              type="single"
              :model-value="preferences.density"
              :spacing="2"
              class="grid w-full grid-cols-3"
              @update:model-value="selectDensity"
            >
              <ToggleGroupItem
                v-for="item in densityOptions"
                :key="item.value"
                :value="item.value"
                variant="outline"
                class="min-w-0 text-xs"
              >
                <span>{{ item.label }}</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </section>

          <section class="flex flex-col gap-3">
            <div>
              <h3 class="text-sm font-semibold">阅读</h3>
              <p class="mt-1 text-xs text-muted-foreground">
                只作用于会话正文与 Markdown 内容；点击即生效，独立于外观设置与恢复默认。
              </p>
            </div>
            <div class="grid w-full gap-4 sm:grid-cols-2">
              <div v-for="group in [
                  { label: '字号', value: preferences.readingSize, options: readingSizeOptions, select: selectReadingSize },
                  { label: '行距', value: preferences.readingLeading, options: readingLeadingOptions, select: selectReadingLeading },
                  { label: '内容宽度', value: preferences.readingWidth, options: readingWidthOptions, select: selectReadingWidth },
                  { label: '代码字号', value: preferences.codeSize, options: codeSizeOptions, select: selectCodeSize },
                ]"
                :key="group.label"
                class="flex flex-col gap-2"
              >
                <p class="text-xs text-muted-foreground">{{ group.label }}</p>
                <ToggleGroup presentation="segmented"
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
                    class="min-w-0 px-1 text-xs"
                  >
                    <span>{{ item.label }}</span>
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>
          </section>

          <section class="flex flex-col gap-3">
            <Disclosure :heading-level="3" v-model:open="themeOpen" >
<template #summary><span>主题</span><Badge>{{ allThemePacks.length }}</Badge></template>
<template #description>点击卡片即切换，与深色模式组合生效；自定义主题删除后可重新上传。</template>
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
                      class="flex w-36 shrink-0 flex-col gap-1.5 rounded-(--component-panel-radius) border p-2 shadow-xs"
                      :class="preferences.themePack === pack.id
                        ? 'border-input bg-accent text-accent-foreground'
                        : 'border-input bg-transparent hover:bg-(--state-hover)'"
                    >
                      <button
                        type="button"
                        class="flex appearance-none text-left"
                        :aria-pressed="preferences.themePack === pack.id"
                        :title="`使用「${pack.name}」`"
                        @click="selectTheme(pack)"
                      >
                        <span class="flex flex-1 overflow-hidden rounded-[max(0px,calc(var(--component-panel-radius)-8px))] border border-border">
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
                      class="flex w-36 shrink-0 flex-col items-center justify-center gap-1 rounded-(--component-panel-radius) border border-dashed p-2 text-muted-foreground transition-colors outline-none hover:bg-(--state-hover) focus-visible:ring-2 focus-visible:ring-ring/50"
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
