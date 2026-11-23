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
import { Check } from '@lucide/vue';
import { hostDisplayLabel } from './hosts/host-view-model';

const props = defineProps<{ active: boolean; selectable?: boolean; selected?: string; compact?: boolean }>();
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
const attentionHosts = computed(() =>
  hosts.value.filter(
    host => host.status !== 'available' || Boolean(host.reason) || Boolean(failures.value[host.name]) || Boolean(host.installation) || Boolean(busy(host)),
  ),
);
function statusText(host: HostStatus): string {
  if (busy(host)) return '安装中…';
  if (host.status === 'available') return '可用';
  if (host.status === 'missing') return '未安装';
  if (host.status === 'unchecked' || host.status === 'checking') return '检测中';
  return '不可用';
}
function statusDotClass(host: HostStatus): string {
  if (busy(host) || host.status === 'unchecked' || host.status === 'checking') return 'bg-warning';
  if (host.status === 'available') return 'bg-success';
  if (host.status === 'error') return 'bg-destructive';
  return 'bg-muted-foreground';
}
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
  <section :class="compact ? 'flex flex-col gap-2' : 'flex flex-col gap-3'" aria-labelledby="host-status-title">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-1">
        <h3 id="host-status-title" :class="compact ? 'text-xs font-medium text-muted-foreground' : 'text-sm font-semibold'">适配器状态</h3>
        <HelpPopover title="适配器状态">
          <p>检测范围：运行服务的机器上，能否通过适配器与宿主通信；检测不会发送模型消息。</p>
          <p>安装方式：Codex、DeepSeek Harness 使用 npm 全局安装；Claude Code 使用官方安装脚本；ZCode 随桌面应用分发，不可自动安装。</p>
          <p>后续配置：登录、API Key 和模型配置需在对应 CLI 中完成，已安装不代表已完成配置。</p>
        </HelpPopover>
      </div>
      <Button type="button" :variant="compact ? 'ghost' : 'outline'" :size="compact ? 'xs' : 'sm'" :disabled="refreshing || pending.length > 0" @click="refresh">
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
    <div v-if="compact" class="@container flex flex-col gap-2" aria-live="polite">
      <div class="grid grid-cols-1 gap-2 @md:grid-cols-2 @lg:grid-cols-3">
        <template v-for="host in hosts" :key="host.name">
          <button
            v-if="selectable && host.status === 'available'"
            type="button"
            :data-host="host.name"
            :data-selected="selected === host.name ? 'true' : undefined"
            :aria-pressed="selected === host.name"
            :disabled="refreshing"
            class="flex min-w-0 items-center justify-between gap-2 rounded-(--component-control-radius) border px-3 py-2 text-left text-sm transition-colors"
            :class="selected === host.name ? 'border-primary bg-accent/40 font-medium text-foreground' : 'border-border bg-card/60 text-foreground hover:bg-accent/30'"
            @click="emit('select', host.name)"
          >
            <span class="flex min-w-0 items-center gap-1.5">
              <Check v-if="selected === host.name" class="size-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span class="truncate">{{ hostDisplayLabel(host.name) }}</span>
            </span>
            <span class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span class="size-1.5 rounded-full" :class="statusDotClass(host)" aria-hidden="true" />
              {{ statusText(host) }}
            </span>
          </button>
          <div
            v-else
            :data-host="host.name"
            class="flex min-w-0 items-center justify-between gap-2 rounded-(--component-control-radius) border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground"
          >
            <span class="truncate">{{ hostDisplayLabel(host.name) }}</span>
            <span class="inline-flex shrink-0 items-center gap-1.5 text-xs">
              <span class="size-1.5 rounded-full" :class="statusDotClass(host)" aria-hidden="true" />
              {{ statusText(host) }}
            </span>
          </div>
        </template>
      </div>
      <Disclosure v-if="attentionHosts.length">
        <template #summary>未就绪或异常适配器详情与安装（{{ attentionHosts.length }}）</template>
        <div class="flex flex-col gap-2 pt-1">
          <div v-for="host in attentionHosts" :key="host.name" class="flex flex-col gap-1.5 border-b border-border/60 pb-2 last:border-b-0 last:pb-0">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-xs font-medium text-foreground">{{ hostDisplayLabel(host.name) }} · {{ statusText(host) }}</span>
              <Button v-if="host.status === 'missing'" type="button" variant="outline" size="xs" :disabled="Boolean(busy(host))" @click="install(host)">
                {{ busy(host) ? '安装中…' : '安装' }}
              </Button>
            </div>
            <p v-if="host.installation || busy(host)" role="status" class="text-xs text-muted-foreground">
              {{ phases[host.installation?.phase ?? 'checking'] }}
            </p>
            <p v-if="host.status === 'missing'" class="text-xs text-muted-foreground">
              安装到运行服务的机器，{{ host.name === 'claude' ? '使用官方安装脚本' : '使用 npm 全局安装' }}。
            </p>
            <pre v-if="host.reason" class="whitespace-pre-wrap break-words text-xs text-muted-foreground">{{ host.reason }}</pre>
            <Alert v-if="failures[host.name] || host.installation?.reason" variant="destructive">
              <AlertDescription>安装未完成。请查看详情，修正安装条件后重试。<pre class="mt-1 whitespace-pre-wrap break-words">{{ failures[host.name] || host.installation?.reason }}</pre></AlertDescription>
            </Alert>
          </div>
        </div>
      </Disclosure>
    </div>
    <ItemGroup v-else class="gap-2" aria-live="polite">
      <Item v-for="host in hosts" :key="host.name" variant="outline" size="sm" :class="selected === host.name ? 'border-primary bg-accent/40' : undefined" :data-selected="selected === host.name ? 'true' : undefined">
        <ItemContent>
          <ItemTitle>{{ hostDisplayLabel(host.name) }}</ItemTitle>
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
          <Button v-if="selectable && host.status === 'available'" type="button" size="sm" :variant="selected === host.name ? 'secondary' : 'outline'" :aria-pressed="selected === host.name" :disabled="refreshing" @click="emit('select', host.name)"><Check v-if="selected === host.name" class="size-4" aria-hidden="true" />{{ selected === host.name ? '已选' : '使用' }}</Button>
          <Badge :variant="host.status === 'error' ? 'destructive' : 'secondary'">
            {{ statusText(host) }}
          </Badge>
          <Button v-if="host.status === 'missing'" type="button" variant="outline" size="sm" :disabled="Boolean(busy(host))" @click="install(host)">
            {{ busy(host) ? '安装中…' : '安装' }}
          </Button>
        </ItemActions>
      </Item>
    </ItemGroup>
  </section>
</template>
