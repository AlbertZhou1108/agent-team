<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/shared/api/client';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
const service = ref<{ version: string; directory: string }>();
const confirm = ref(false), stopping = ref(false), stopped = ref(false), error = ref('');
onMounted(async () => { try { service.value = await api.service(); } catch (cause) { error.value = String(cause); } });
async function stop() {
  confirm.value = false; stopping.value = true;
  try { await api.stopService(); stopped.value = true; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { stopping.value = false; }
}
</script>
<template>
  <section class="flex flex-col gap-3">
    <h3 class="text-sm font-semibold">本地服务</h3>
    <p class="text-sm text-muted-foreground">关闭网页后，服务和工作仍会继续。升级前请先停止服务。</p>
    <p v-if="service" class="break-all text-sm">版本 {{ service.version }} · 数据位置：{{ service.directory }}</p>
    <Button v-if="!stopped" variant="outline" :disabled="stopping" @click="confirm = true">{{ stopping ? '停止中…' : '停止本地服务' }}</Button>
    <Alert v-if="stopped"><AlertDescription>正在停止本地服务。再次点击应用启动入口即可重新打开。</AlertDescription></Alert>
    <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>
    <ConfirmDialog :open="confirm" title="停止本地服务？" description="将中断正在进行的工作并保留记录。无法确认已停止的宿主运行，重启后仍需要核实。" confirm-text="停止服务" @confirm="stop" @cancel="confirm = false" />
  </section>
</template>
