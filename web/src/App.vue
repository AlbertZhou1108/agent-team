<script setup lang="ts">
import GlobalSearch from '@/features/productivity/GlobalSearch.vue';
import { RouterView } from 'vue-router';
import { Toaster } from 'vue-sonner';
import 'vue-sonner/style.css';
import { startThemeApplication } from '@/theme/application';

startThemeApplication();
</script>

<template>
  <RouterView />
  <GlobalSearch />
  <Toaster position="bottom-right" />
</template>
