<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { ArrowUpRight } from '@lucide/vue';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { directiveStatus } from '@/features/messages/directive-status';
import type { TeamRequest } from '@/shared/api/raw-types';
defineProps<{ request: TeamRequest; teamName: string }>();
</script>
<template>
  <Card class="mt-3 min-w-0">
    <CardHeader>
      <CardTitle>{{ teamName }} · 请求回执</CardTitle>
      <CardDescription>{{ directiveStatus(request.delivery) }}</CardDescription>
    </CardHeader>
    <CardContent v-if="request.receipts.length" class="flex flex-col gap-3">
      <p v-for="receipt in request.receipts" :key="receipt.id" class="whitespace-pre-wrap wrap-anywhere">{{ receipt.text }}</p>
    </CardContent>
    <CardFooter>
      <Button as-child variant="outline" size="sm">
        <RouterLink :to="{ name: 'group', params: { groupId: request.group_id }, query: { message: request.receipts.at(-1)?.sourceMessageIds[0] ?? request.message_id } }">进入团队继续沟通<ArrowUpRight data-icon="inline-end" /></RouterLink>
      </Button>
    </CardFooter>
  </Card>
</template>
