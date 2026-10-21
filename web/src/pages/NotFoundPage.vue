<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue';
import { useRouter } from 'vue-router';
import { Button } from '@/components/ui/button';

const router = useRouter();
</script>

<template>
  <main class="grid min-h-screen place-items-center px-6">
    <section class="panel w-full max-w-md p-8 text-center">
      <p class="eyebrow">404</p>
      <h1 class="mt-2 text-2xl font-semibold">没有这个观测页面</h1>
      <p class="mt-3 text-sm text-muted">链接可能已失效，或对应群已经被删除。</p>
      <Button class="mt-6" @click="router.push('/groups')">
        <ArrowLeft :size="15" />
        返回群列表
      </Button>
    </section>
  </main>
</template>
