<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import type { HostStatus } from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';

const props = defineProps<{ active: boolean }>();
const pending = ref<string[]>([]);
const failures = ref<Record<string, string>>({});
const statuses = useQuery({
  queryKey: ['host-statuses'],
  queryFn: () => api.hostStatuses(),
  enabled: computed(() => props.active),
  retry: false,
  staleTime: 0,
  gcTime: 0,
  refetchOnWindowFocus: false,
});
const installations = useQuery({
  queryKey: ['host-installations'],
  queryFn: () => api.hostInstallations(),
  enabled: computed(() => props.active),
  retry: false,
  gcTime: 0,
  staleTime: 0,
  refetchOnWindowFocus: false,
  refetchInterval: computed(() => pending.value.length ? 2000 : (query: { state: { data?: Array<{ installing?: boolean }> } }) => query.state.data?.some(host => host.installing) ? 2000 : false),
});
watch(installations.data, (next, previous) => {
  if (previous?.some(host => host.installing && !pending.value.includes(host.name) && next?.some(item => item.name === host.name && !item.installing))) {
    void statuses.refetch();
  }
});
const hosts = computed(() => (statuses.data.value ?? []).map(host => ({
  ...host,
  ...installations.data.value?.find(item => item.name === host.name),
})));
const labels: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', dsh: 'DSH' };
const phases = { checking: '检查安装条件（1/3）', installing: '执行安装（2/3）', verifying: '确认安装结果（3/3）', completed: '安装完成', failed: '安装失败' };
const busy = (host: HostStatus) => pending.value.includes(host.name) || host.installing;
function message(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  try { return JSON.parse(value).error || value; } catch { return value; }
}
async function install(host: HostStatus) {
  if (busy(host)) return;
  pending.value.push(host.name);
  delete failures.value[host.name];
  try {
    await api.installHost(host.name);
  } catch (error) { failures.value[host.name] = message(error); }
  finally {
    await installations.refetch();
    pending.value = pending.value.filter(name => name !== host.name);
    await statuses.refetch();
  }
}
</script>

<template>
  <section class="flex flex-col gap-3" aria-labelledby="host-status-title">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h3 id="host-status-title" class="text-sm font-semibold">适配器状态</h3>
        <p class="mt-1 text-xs text-muted-foreground">检查运行服务的机器上是否已安装 CLI。API Key、登录和模型配置请在宿主中自行完成。</p>
      </div>
      <Button type="button" variant="outline" size="sm" :disabled="statuses.isFetching.value || pending.length > 0" @click="statuses.refetch()">
        {{ statuses.isFetching.value ? '检测中…' : '重新检测' }}
      </Button>
    </div>
    <Alert v-if="statuses.error.value" variant="destructive">
      <AlertDescription>{{ message(statuses.error.value) }}</AlertDescription>
    </Alert>
    <p v-if="statuses.isPending.value" role="status" class="text-sm text-muted-foreground">正在检测宿主…</p>
    <ItemGroup class="gap-2" aria-live="polite">
      <Item v-for="host in hosts" :key="host.name" variant="outline" size="sm">
        <ItemContent>
          <ItemTitle>{{ labels[host.name] ?? host.name }}</ItemTitle>
          <p v-if="host.installation || busy(host)" role="status" class="text-xs text-muted-foreground">
            {{ phases[host.installation?.phase ?? 'checking'] }}
          </p>
          <p v-if="host.reason" class="text-xs text-muted-foreground break-all">{{ host.reason }}</p>
          <Alert v-if="failures[host.name] || host.installation?.reason" variant="destructive">
            <AlertDescription class="break-all">安装失败：{{ failures[host.name] || host.installation?.reason }}</AlertDescription>
          </Alert>
        </ItemContent>
        <ItemActions>
          <Badge :variant="host.status === 'error' ? 'destructive' : 'secondary'">
            {{ busy(host) ? '安装中…' : host.status === 'available' ? '已安装' : host.status === 'missing' ? '未安装' : '异常' }}
          </Badge>
          <Button v-if="host.status === 'missing'" type="button" variant="outline" size="sm" :disabled="Boolean(busy(host))" @click="install(host)">
            {{ busy(host) ? '安装中…' : '安装' }}
          </Button>
        </ItemActions>
      </Item>
    </ItemGroup>
  </section>
</template>
