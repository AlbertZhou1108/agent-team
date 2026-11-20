<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ArrowLeft } from '@lucide/vue';
import { api } from '@/shared/api/client';
import type { DesktopApplicationStatus, DesktopInstallResult } from '@/shared/api/raw-types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Disclosure } from '@/components/ui/disclosure';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';
import {
  availabilityLabel,
  availabilityVariant,
  capabilityLabel,
  capabilityVariant,
  cliHostName,
  detailBanner,
  detailCapabilities,
  detailFacts,
  desktopAvailability,
  HOST_LABELS,
} from './host-view-model';
import type { HostCapability, HostKind } from './host-view-model';

const props = defineProps<{ kind: HostKind }>();
const emit = defineEmits<{ back: [] }>();

const pending = ref(false);
const confirming = ref(false);
const failures = ref<string | null>(null);
const installResult = ref<DesktopInstallResult | null>(null);
const detailCapability = ref<HostCapability | null>(null);
const cliPending = ref(false);
const cliFailure = ref<string | null>(null);

const applications = useQuery({
  queryKey: ['desktop-applications'],
  queryFn: () => api.desktopApplications(),
  retry: false,
  staleTime: 30000,
  gcTime: 30000,
  refetchOnWindowFocus: false,
});

const statuses = useQuery({
  queryKey: ['host-statuses'],
  queryFn: () => api.probeHosts(),
  retry: false,
  staleTime: 30000,
  gcTime: 30000,
  refetchOnWindowFocus: false,
});

const application = computed(() => applications.data.value?.find(item => item.kind === props.kind));
const cli = computed(() => statuses.data.value?.find(host => host.name === cliHostName(props.kind)));

const title = computed(() => `${HOST_LABELS[props.kind]} 桌面应用`);
const availability = computed(() => desktopAvailability(application.value));
const banner = computed(() => detailBanner(application.value));
const capabilities = computed(() => detailCapabilities(props.kind, application.value, cli.value));
const facts = computed(() => detailFacts(application.value));

function message(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  try { return JSON.parse(value).error || value; } catch { return value; }
}

function installText(kind: DesktopInstallResult) {
  return JSON.stringify(kind.mcpConfig ?? {}, null, 2);
}

async function run(action: () => Promise<unknown>) {
  if (pending.value) return;
  pending.value = true;
  failures.value = null;
  try {
    await action();
    await applications.refetch();
  } catch (error) {
    failures.value = message(error);
  } finally {
    pending.value = false;
  }
}

async function detect() {
  await run(() => api.desktopDetect());
}

async function verify(item: DesktopApplicationStatus) {
  const confirmed = confirming.value;
  await run(async () => {
    const result = await api.desktopVerify(item.kind, confirmed);
    if (result.needsConfirmation) {
      confirming.value = true;
      return;
    }
    confirming.value = false;
    if (!result.verified) failures.value = result.reason ?? '验证未通过';
  });
}

async function install(item: DesktopApplicationStatus) {
  await run(async () => {
    const result = await api.desktopInstall(item.kind);
    installResult.value = result;
  });
}

async function disable(item: DesktopApplicationStatus) {
  await run(() => api.desktopDisable(item.kind));
}

async function enable(item: DesktopApplicationStatus) {
  await run(() => api.desktopEnable(item.kind));
}

async function remove(item: DesktopApplicationStatus) {
  await run(() => api.desktopRemove(item.kind));
}

// CLI 安装以前在设置页的「CLI 适配器」区块里；那一块并进宿主详情后，入口跟着搬到这里。
async function installCli() {
  const host = cli.value;
  if (!host || cliPending.value) return;
  cliPending.value = true;
  cliFailure.value = null;
  try {
    await api.installHost(host.name);
  } catch (error) {
    cliFailure.value = message(error);
  } finally {
    await statuses.refetch();
    cliPending.value = false;
  }
}
</script>

<template>
  <section class="flex flex-col gap-4" :aria-label="`${title}详情`">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex items-center gap-2">
        <Button variant="ghost" size="icon" title="返回宿主列表" aria-label="返回宿主列表" @click="emit('back')">
          <ArrowLeft />
        </Button>
        <div class="min-w-0">
          <h2 class="text-lg font-semibold">{{ title }}</h2>
          <p class="text-xs text-muted-foreground">宿主详情</p>
        </div>
      </div>
      <Badge :variant="availabilityVariant(availability)">{{ availabilityLabel(availability) }}</Badge>
    </div>

    <Alert v-if="applications.error.value">
      <AlertDescription>桌面应用状态读取失败，请检查服务连接。</AlertDescription>
    </Alert>

    <Alert v-if="statuses.error.value">
      <AlertDescription>CLI 适配器状态读取失败，请检查服务连接。</AlertDescription>
    </Alert>

    <p v-if="applications.isPending.value" role="status" class="text-sm text-muted-foreground">正在读取桌面应用状态…</p>

    <Empty v-if="applications.isSuccess.value && !application">
      <EmptyHeader>
        <EmptyTitle>未检测到该宿主</EmptyTitle>
        <EmptyDescription>可重新检测后再查看。</EmptyDescription>
      </EmptyHeader>
      <Button type="button" variant="outline" size="sm" :disabled="pending" @click="detect">
        {{ pending ? '检测中…' : '重新检测' }}
      </Button>
    </Empty>

    <template v-if="application">
      <div class="rounded-md border border-border bg-muted/30 p-4">
        <p class="text-sm font-medium">{{ banner.title }}</p>
        <p class="mt-1 text-xs text-muted-foreground">{{ banner.description }}</p>
      </div>

      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div class="flex flex-col gap-3">
          <h3 class="text-sm font-semibold">角色与能力</h3>
          <ItemGroup class="gap-2">
            <Item v-for="capability in capabilities" :key="capability.label" variant="outline" size="sm" class="min-h-[100px]">
              <ItemContent class="min-w-0 flex-1">
                <ItemTitle>
                  {{ capability.label }}
                  <Badge :variant="capabilityVariant(capability.state)">{{ capabilityLabel(capability.state) }}</Badge>
                </ItemTitle>
                <p class="text-xs text-muted-foreground">{{ capability.description }}</p>
                <p v-if="capability.action === 'install-cli' && cliFailure" class="text-xs text-destructive">{{ cliFailure }}</p>
              </ItemContent>
              <ItemActions class="ml-auto">
                <Button
                  v-if="capability.action === 'install-cli' && cli?.status === 'missing'"
                  type="button"
                  variant="outline"
                  size="sm"
                  :disabled="cliPending"
                  @click="installCli"
                >
                  {{ cliPending ? '安装中…' : '安装' }}
                </Button>
                <Button
                  v-if="capability.state !== 'available'"
                  type="button"
                  variant="outline"
                  size="sm"
                  @click="detailCapability = capability"
                >
                  详情
                </Button>
              </ItemActions>
            </Item>
          </ItemGroup>
          <div class="rounded-md border border-border p-4 text-xs text-muted-foreground">
            <p class="font-medium text-foreground">说明</p>
            <p class="mt-1">桌面主控用于指挥团队；内置引擎用于执行成员任务；CLI 适配器状态按探测结果展示。</p>
          </div>
        </div>

        <div class="flex flex-col gap-3">
          <h3 class="text-sm font-semibold">接入信息</h3>
          <Item variant="outline" size="sm" class="items-start">
            <ItemContent class="min-w-0 flex-1">
              <ItemTitle>连接事实</ItemTitle>
              <div v-for="fact in facts" :key="fact.label" class="mt-2 flex items-start justify-between gap-3 text-xs">
                <span class="shrink-0 text-muted-foreground">{{ fact.label }}</span>
                <span class="min-w-0 break-all text-right">{{ fact.value }}</span>
              </div>
            </ItemContent>
          </Item>

          <Item variant="outline" size="sm" class="items-start">
            <ItemContent class="min-w-0 flex-1">
              <ItemTitle>可用操作</ItemTitle>
              <div class="mt-3 flex flex-wrap gap-2">
                <template v-if="application.installed">
                  <Button type="button" variant="outline" size="sm" :disabled="pending" @click="verify(application)">
                    {{ pending ? '处理中…' : confirming ? '确认消耗额度并验证' : '验证连接' }}
                  </Button>
                  <Button type="button" variant="outline" size="sm" :disabled="pending" @click="install(application)">重新接入</Button>
                  <Button v-if="!application.userDisabled" type="button" variant="outline" size="sm" :disabled="pending" @click="disable(application)">停用</Button>
                  <Button v-if="application.userDisabled" type="button" variant="outline" size="sm" :disabled="pending" @click="enable(application)">启用</Button>
                  <Button type="button" variant="outline" size="sm" :disabled="pending" @click="remove(application)">移除登记</Button>
                </template>
                <Button v-else type="button" variant="outline" size="sm" :disabled="pending" @click="install(application)">接入</Button>
              </div>
              <Alert v-if="failures" class="mt-3" variant="destructive">
                <AlertDescription>{{ failures }}</AlertDescription>
              </Alert>
              <div v-if="installResult" class="mt-3 rounded-md border p-2 text-xs text-muted-foreground">
                <p>{{ installResult.nextStep }}</p>
                <Disclosure v-if="installResult.manual && installResult.mcpConfig">
                  <template #summary>粘贴到桌面应用 Profile 的 MCP 配置</template>
                  <pre class="whitespace-pre-wrap break-words">{{ installText(installResult) }}</pre>
                </Disclosure>
                <p v-if="installResult.configPath">已写入：<code>{{ installResult.configPath }}</code></p>
                <p v-if="installResult.backupPath">配置备份：<code>{{ installResult.backupPath }}</code></p>
              </div>
            </ItemContent>
          </Item>
        </div>
      </div>
    </template>

    <Dialog :open="detailCapability !== null" @update:open="(next) => { if (!next) detailCapability = null; }">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {{ detailCapability ? `${detailCapability.label} · ${capabilityLabel(detailCapability.state)}` : '' }}
          </DialogTitle>
          <DialogDescription>{{ detailCapability?.detail?.description }}</DialogDescription>
        </DialogHeader>
        <pre class="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">{{ detailCapability?.detail?.body }}</pre>
        <DialogFooter>
          <Button type="button" variant="outline" @click="detailCapability = null">关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
