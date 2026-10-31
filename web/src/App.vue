<script setup lang="ts">
import { RouterView } from 'vue-router';
import { Toaster } from 'vue-sonner';
import 'vue-sonner/style.css';
import { startThemeApplication } from '@/theme/application';

startThemeApplication();
</script>

<template>
  <RouterView />
  <Toaster position="bottom-right" />
</template>
