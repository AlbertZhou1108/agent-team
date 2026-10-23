<script setup lang="ts">
import { Card, CardContent } from '@/components/ui/card';
import { ArrowLeft } from '@lucide/vue';
import { useRouter } from 'vue-router';
import { Button } from '@/components/ui/button';

const router = useRouter();
</script>

<template>
  <main class="grid min-h-screen place-items-center px-6">
    <Card class="panel w-full max-w-md text-center">
      <CardContent>
        <p class="eyebrow">404</p>
        <h1 class="mt-2 text-2xl font-semibold">没有这个观测页面</h1>
        <p class="mt-3 text-sm text-muted-foreground">
          链接可能已失效，或对应群已经被删除。
        </p>
        <Button class="mt-6" @click="router.push('/groups')">
          <ArrowLeft />
          返回群列表
        </Button>
      </CardContent>
    </Card>
  </main>
</template>
