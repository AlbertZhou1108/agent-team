<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide } from 'vue';
import { RouterView, useRouter } from 'vue-router';
import { Toaster } from 'vue-sonner';
import 'vue-sonner/style.css';
import {
  PLUGIN_SEARCH_CONTEXT_KEY,
  allPluginStaticEntries,
  collectPluginCommands,
  collectPluginOverlays,
  collectSearchProviders,
  matchHotkey,
} from '@/plugins';
import { usePreferencesStore } from '@/stores/preferences';
import { useUiStore } from '@/stores/ui';
import { startThemeApplication } from '@/theme/application';

startThemeApplication();
const preferences = usePreferencesStore();
const ui = useUiStore();
const router = useRouter();

const overlays = computed(() => collectPluginOverlays(preferences.toolModules));
const searchProviders = computed(() => collectSearchProviders(preferences.toolModules));
const disabledPlugins = computed(() => preferences.toolModules.disabled);

provide(PLUGIN_SEARCH_CONTEXT_KEY, {
  providers: searchProviders,
  disabled: disabledPlugins,
  allStaticEntries: allPluginStaticEntries(),
});

function handlePluginHotkey(event: KeyboardEvent) {
  for (const { command } of collectPluginCommands(preferences.toolModules)) {
    if (command.hotkey && matchHotkey(event, command.hotkey)) {
      event.preventDefault();
      command.run({ router, ui });
      return;
    }
  }
}

onMounted(() => window.addEventListener('keydown', handlePluginHotkey));
onBeforeUnmount(() => window.removeEventListener('keydown', handlePluginHotkey));
</script>

<template>
  <RouterView />
  <div v-for="overlay in overlays" :key="overlay.key" class="contents">
    <component :is="overlay.component" />
  </div>
  <Toaster
    position="bottom-right"
    :theme="preferences.colorMode"
    close-button
    close-button-position="top-right"
    :toast-options="{ closeButtonAriaLabel: '关闭提示' }"
    :style="{
      '--normal-bg': 'var(--popover)',
      '--normal-bg-hover': 'var(--accent)',
      '--normal-text': 'var(--popover-foreground)',
      '--normal-border': 'var(--border)',
      '--normal-border-hover': 'var(--border)',
      '--border-radius': 'var(--component-card-radius)',
    }"
  />
</template>
