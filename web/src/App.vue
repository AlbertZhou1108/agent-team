<script setup lang="ts">
import GlobalSearch from '@/features/productivity/GlobalSearch.vue';
import { RouterView } from 'vue-router';
import { Toaster } from 'vue-sonner';
import 'vue-sonner/style.css';
import { startGlassRefraction } from '@/theme/glass-refraction';
import { startGlassLighting } from '@/theme/glass-light';
import { startThemeApplication } from '@/theme/application';

startThemeApplication();
startGlassLighting();
startGlassRefraction();
</script>

<template>
  <RouterView />
  <GlobalSearch />
  <Toaster position="bottom-right" />
</template>
