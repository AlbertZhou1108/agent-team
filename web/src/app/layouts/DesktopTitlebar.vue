<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Bot, Copy, Minus, Square, X } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { DesktopMenuAction, DesktopMenuState, DesktopWindowAction } from '@/env';

/**
 * Electron 桌面壳统一单行 38px 自定义顶栏：
 * 仅在 globalThis.agentTeam?.isDesktop 为真时挂载；浏览器入口完全不渲染。
 * macOS 保留左侧系统交通灯安全区并由系统顶部菜单栏承载菜单；Windows/Linux 渲染全中文紧凑下拉菜单与平台窗口按钮。
 */
const desktop = computed(() => globalThis.agentTeam);
const isDesktop = computed(() => Boolean(desktop.value?.isDesktop));
const platform = computed(() => desktop.value?.platform ?? 'win32');
const isMac = computed(() => platform.value === 'darwin');
const isLinux = computed(() => platform.value === 'linux');

const maximized = ref(false);
const menuState = ref<DesktopMenuState>({
  hasService: true,
  dev: false,
  showingError: false,
  version: '',
});

const statusLabel = computed(() => {
  if (menuState.value.showingError || !menuState.value.hasService) {
    return menuState.value.dev ? '开发模式' : '服务未就绪';
  }
  return '本地服务就绪';
});

const statusDotClass = computed(() => {
  if (menuState.value.hasService && !menuState.value.showingError) return 'bg-success';
  if (menuState.value.dev) return 'bg-warning';
  return 'bg-destructive';
});

function runWindowControl(action: DesktopWindowAction) {
  void desktop.value?.windowControl?.(action);
}

function runMenuAction(action: DesktopMenuAction) {
  void desktop.value?.runMenuAction?.(action);
}

let stopMaximizedListener: (() => void) | undefined;
let stopMenuStateListener: (() => void) | undefined;

onMounted(async () => {
  if (!isDesktop.value) return;
  document.documentElement.setAttribute('data-desktop', 'true');
  stopMaximizedListener = desktop.value?.onMaximizedChange?.((value) => {
    maximized.value = value;
  });
  stopMenuStateListener = desktop.value?.onMenuStateChange?.((state) => {
    menuState.value = state;
  });
  try {
    if (desktop.value?.isMaximized) maximized.value = await desktop.value.isMaximized();
    if (desktop.value?.getMenuState) menuState.value = await desktop.value.getMenuState();
  } catch {
    // 主进程尚未就绪时保留默认状态。
  }
});

onBeforeUnmount(() => {
  document.documentElement.removeAttribute('data-desktop');
  stopMaximizedListener?.();
  stopMenuStateListener?.();
});
</script>

<template>
  <header
    v-if="isDesktop"
    data-testid="desktop-titlebar"
    :data-platform="platform"
    class="desktop-titlebar-drag sticky top-0 z-40 flex h-(--desktop-titlebar-height) w-full shrink-0 items-center justify-between border-b border-border bg-background/95 text-foreground select-none"
  >
    <div
      class="desktop-titlebar-no-drag flex items-center gap-2"
      :class="isMac ? 'pl-[76px] pr-3' : 'pl-3'"
    >
      <span
        class="flex size-5 shrink-0 items-center justify-center rounded-(--component-chip-radius) border border-border bg-muted/60 text-foreground"
        aria-hidden="true"
      >
        <Bot class="size-3.5" />
      </span>
      <span class="text-xs font-semibold tracking-tight text-foreground">Agent Team</span>

      <nav v-if="!isMac" aria-label="桌面应用菜单" class="flex items-center gap-0.5 pl-1">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button type="button" variant="ghost" size="xs" data-testid="desktop-menu-file">文件</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-64">
            <DropdownMenuItem :disabled="!menuState.hasService" @select="runMenuAction('open-in-browser')">
              在浏览器中打开
            </DropdownMenuItem>
            <DropdownMenuItem @select="runMenuAction('reconnect-service')">
              重新连接服务
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="runMenuAction('close-window')">
              关闭窗口（隐藏到托盘）
              <DropdownMenuShortcut>Ctrl+W</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem @select="runMenuAction('quit')">
              退出 Agent Team
              <DropdownMenuShortcut>Ctrl+Q</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button type="button" variant="ghost" size="xs" data-testid="desktop-menu-service">服务</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-52">
            <DropdownMenuItem disabled>
              状态：{{ statusLabel }}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="runMenuAction('reconnect-service')">
              重新连接本地服务
            </DropdownMenuItem>
            <DropdownMenuItem
              :disabled="menuState.dev || !menuState.hasService"
              @select="runMenuAction('stop-service')"
            >
              停止本地服务
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button type="button" variant="ghost" size="xs" data-testid="desktop-menu-help">帮助</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-52">
            <DropdownMenuItem @select="runMenuAction('open-guide')">
              使用指南
            </DropdownMenuItem>
            <DropdownMenuItem v-if="menuState.dev" @select="runMenuAction('toggle-devtools')">
              切换开发者工具
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              关于 Agent Team{{ menuState.version ? ` · v${menuState.version}` : '' }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </div>

    <div class="min-w-4 flex-1" aria-hidden="true" />

    <div
      class="desktop-titlebar-no-drag flex h-full items-center gap-2"
      :class="isMac ? 'pr-3' : isLinux ? 'pr-2.5' : 'pr-0'"
    >
      <span
        data-testid="desktop-service-status"
        class="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-2xs text-muted-foreground"
      >
        <span class="size-1.5 rounded-full" :class="statusDotClass" aria-hidden="true" />
        {{ statusLabel }}
      </span>

      <div v-if="isLinux" class="flex items-center gap-1.5">
        <button
          type="button"
          data-testid="window-minimize"
          aria-label="最小化"
          class="flex size-6 items-center justify-center rounded-full bg-muted/60 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="runWindowControl('minimize')"
        >
          <Minus class="size-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="window-maximize"
          :aria-label="maximized ? '还原' : '最大化'"
          class="flex size-6 items-center justify-center rounded-full bg-muted/60 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="runWindowControl('maximize-toggle')"
        >
          <Copy v-if="maximized" class="size-2.5" aria-hidden="true" />
          <Square v-else class="size-2.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="window-close"
          aria-label="关闭窗口"
          class="flex size-6 items-center justify-center rounded-full bg-muted/60 text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          @click="runWindowControl('close')"
        >
          <X class="size-3" aria-hidden="true" />
        </button>
      </div>

      <div v-else-if="!isMac" class="flex h-full items-center">
        <button
          type="button"
          data-testid="window-minimize"
          aria-label="最小化"
          class="flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="runWindowControl('minimize')"
        >
          <Minus class="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="window-maximize"
          :aria-label="maximized ? '还原' : '最大化'"
          class="flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="runWindowControl('maximize-toggle')"
        >
          <Copy v-if="maximized" class="size-3" aria-hidden="true" />
          <Square v-else class="size-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="window-close"
          aria-label="关闭窗口"
          class="flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          @click="runWindowControl('close')"
        >
          <X class="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  </header>
</template>
