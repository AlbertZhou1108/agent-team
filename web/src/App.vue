<script setup lang="ts">
import GlobalSearch from '@/features/productivity/GlobalSearch.vue';
import { RouterView } from 'vue-router';
import { Toaster } from 'vue-sonner';
import 'vue-sonner/style.css';
import { usePreferencesStore } from '@/stores/preferences';
import { startThemeApplication } from '@/theme/application';

startThemeApplication();
const preferences = usePreferencesStore();
</script>

<template>
  <RouterView />
  <GlobalSearch />
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
