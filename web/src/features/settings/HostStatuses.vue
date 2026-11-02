<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import HelpPopover from '@/components/panel/HelpPopover.vue';
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import type { HostStatus } from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';

const props = defineProps<{ active: boolean; selectable?: boolean }>();
const emit = defineEmits<{ select: [host: string] }>();
const pending = ref<string[]>([]);
const failures = ref<Record<string, string>>({});
const statuses = useQuery({
  queryKey: ['host-statuses'],
  queryFn: () => api.probeHosts(),
  enabled: computed(() => props.active),
  retry: false,
  staleTime: 30000,
  gcTime: 30000,
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
const refreshing = computed(() => statuses.isFetching.value || installations.isFetching.value);
async function refresh() { await Promise.all([statuses.refetch(), installations.refetch()]); }
const hosts = computed(() => (statuses.data.value ?? []).map(host => ({
  ...host,
  ...(installations.dataUpdatedAt.value >= statuses.dataUpdatedAt.value ? installations.data.value?.find(item => item.name === host.name) : {}),
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
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex items-center gap-1">
        <h3 id="host-status-title" class="text-sm font-semibold">适配器状态</h3>
        <HelpPopover title="适配器状态">
          <p>检测范围：运行服务的机器上，能否通过适配器与宿主通信；检测不会发送模型消息。</p>
          <p>安装方式：Codex、DSH 使用 npm 全局安装；Claude Code 使用官方安装脚本。</p>
          <p>后续配置：登录、API Key 和模型配置需在对应 CLI 中完成，已安装不代表已完成配置。</p>
        </HelpPopover>
      </div>
      <Button type="button" variant="outline" size="sm" :disabled="refreshing || pending.length > 0" @click="refresh">
        {{ refreshing ? '检测中…' : '重新检测' }}
      </Button>
    </div>
    <Alert v-if="statuses.error.value" variant="destructive">
      <AlertDescription>检测失败，请检查服务连接后重新检测。<Disclosure><template #summary>错误详情</template><pre class="whitespace-pre-wrap break-words">{{ message(statuses.error.value) }}</pre></Disclosure></AlertDescription>
    </Alert>
    <p v-if="statuses.isPending.value" role="status" class="text-sm text-muted-foreground">正在检测适配器…</p>
    <Alert v-if="installations.error.value" variant="destructive"><AlertDescription>安装进度暂时无法更新，以下可能是上次记录。请检查服务连接。
      <Button type="button" variant="outline" size="sm" :disabled="refreshing" @click="refresh">重试</Button>
      <Disclosure><template #summary>错误详情</template><pre class="whitespace-pre-wrap break-words">{{ message(installations.error.value) }}</pre></Disclosure>
    </AlertDescription></Alert>
    <Empty v-if="statuses.isSuccess.value && !hosts.length"><EmptyHeader><EmptyTitle>暂无可检测的适配器</EmptyTitle><EmptyDescription>请在服务中配置适配器后重新检测。</EmptyDescription></EmptyHeader></Empty>
    <ItemGroup class="gap-2" aria-live="polite">
      <Item v-for="host in hosts" :key="host.name" variant="outline" size="sm">
        <ItemContent>
          <ItemTitle>{{ labels[host.name] ?? host.name }}</ItemTitle>
          <p v-if="host.installation || busy(host)" role="status" class="text-xs text-muted-foreground">
            {{ phases[host.installation?.phase ?? 'checking'] }}
          </p>
          <Disclosure v-if="host.reason"><template #summary>查看原因</template><pre class="whitespace-pre-wrap break-words">{{ host.reason }}</pre></Disclosure>
          <Alert v-if="failures[host.name] || host.installation?.reason" variant="destructive">
            <AlertDescription>安装未完成。请查看详情，修正安装条件后重试。<Disclosure><template #summary>错误详情</template><pre class="whitespace-pre-wrap break-words">{{ failures[host.name] || host.installation?.reason }}</pre></Disclosure></AlertDescription>
          </Alert>
        </ItemContent>
        <p v-if="host.status === 'missing'" class="text-xs text-muted-foreground">安装到运行服务的机器，{{ host.name === 'claude' ? '使用官方安装脚本' : '使用 npm 全局安装' }}。</p>
        <ItemActions>
          <Button v-if="selectable && host.status === 'available'" type="button" size="sm" :disabled="refreshing" @click="emit('select', host.name)">使用</Button>
          <Badge :variant="host.status === 'error' ? 'destructive' : 'secondary'">
            {{ busy(host) ? '安装中…' : host.status === 'available' ? '可用' : host.status === 'missing' ? '未安装' : host.status === 'unchecked' || host.status === 'checking' ? '检测中' : '不可用' }}
          </Badge>
          <Button v-if="host.status === 'missing'" type="button" variant="outline" size="sm" :disabled="Boolean(busy(host))" @click="install(host)">
            {{ busy(host) ? '安装中…' : '安装' }}
          </Button>
        </ItemActions>
      </Item>
    </ItemGroup>
  </section>
</template>
