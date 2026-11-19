<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import HelpPopover from '@/components/panel/HelpPopover.vue';
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import type { DesktopApplicationStatus, DesktopInstallResult } from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';

const props = defineProps<{ active: boolean }>();
const pending = ref<string[]>([]);
const failures = ref<Record<string, string>>({});
// 额度确认是显式两步:第一次点「验证」拿到费用说明,按钮转为确认文案,再点才真正执行。
const confirming = ref<string[]>([]);
const installResults = ref<Record<string, DesktopInstallResult>>({});

const applications = useQuery({
  queryKey: ['desktop-applications'],
  queryFn: () => api.desktopApplications(),
  enabled: computed(() => props.active),
  retry: false,
  staleTime: 30000,
  gcTime: 30000,
  refetchOnWindowFocus: false,
});

function message(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  try { return JSON.parse(value).error || value; } catch { return value; }
}
function busy(kind: string) { return pending.value.includes(kind); }
function stateBadge(item: DesktopApplicationStatus) {
  if (!item.installed) return '未安装';
  if (item.state === 'available') return '可用';
  if (item.state === 'pull-only') return '可用，仅手动查看消息';
  return item.userDisabled ? '已停用' : '不可用';
}
function badgeVariant(item: DesktopApplicationStatus) {
  if (item.installed && (item.state === 'available' || item.state === 'pull-only')) return 'secondary' as const;
  return 'destructive' as const;
}
async function run(kind: string, action: () => Promise<unknown>) {
  if (busy(kind)) return;
  pending.value.push(kind);
  delete failures.value[kind];
  try {
    await action();
    await applications.refetch();
  } catch (error) { failures.value[kind] = message(error); }
  finally {
    pending.value = pending.value.filter(item => item !== kind);
  }
}
async function detect() { await run('__detect__', () => api.desktopDetect()); }
async function verify(item: DesktopApplicationStatus) {
  const confirmed = confirming.value.includes(item.kind);
  await run(item.kind, async () => {
    const result = await api.desktopVerify(item.kind, confirmed);
    if (result.needsConfirmation) {
      // 额度确认请求:保持确认态,按钮转为「确认消耗额度并验证」等待第二次点击。
      confirming.value.push(item.kind);
      return;
    }
    // 确认已被消费(无论验证成败),确认态只在此处退出。
    confirming.value = confirming.value.filter(kind => kind !== item.kind);
    if (!result.verified) failures.value[item.kind] = result.reason ?? '验证未通过';
  });
}
async function disable(item: DesktopApplicationStatus) { await run(item.kind, () => api.desktopDisable(item.kind)); }
async function enable(item: DesktopApplicationStatus) { await run(item.kind, () => api.desktopEnable(item.kind)); }
async function remove(item: DesktopApplicationStatus) { await run(item.kind, () => api.desktopRemove(item.kind)); }
async function install(item: DesktopApplicationStatus) {
  await run(item.kind, async () => {
    const result = await api.desktopInstall(item.kind);
    installResults.value = { ...installResults.value, [item.kind]: result };
    await applications.refetch();
  });
}
const installResult = (kind: string) => installResults.value[kind];
const diagnosticsText = (item: DesktopApplicationStatus) => JSON.stringify(item.diagnostics, null, 2);
const mcpConfigText = (kind: string) => JSON.stringify(installResult(kind)?.mcpConfig ?? {}, null, 2);
</script>

<template>
  <section class="flex flex-col gap-3" aria-labelledby="desktop-apps-title">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex items-center gap-1">
        <h3 id="desktop-apps-title" class="text-sm font-semibold">桌面应用集成</h3>
        <HelpPopover title="桌面应用集成">
          <p>检测桌面应用安装与内嵌执行引擎；「验证」会创建两个短会话并可能消耗该应用的少量模型额度，点击后需再次确认。</p>
          <p>Codex Desktop 接入会写入 ~/.codex/config.toml 受管条目（写入前自动备份）；Claude Desktop 只占用 claude_desktop_config.json 中的 agent_team 键；DSH Desktop 的配置需手动粘贴到其 Profile 设置。</p>
          <p>状态含义：可用=主控与引擎检查均通过；可用，仅手动查看消息=引擎可用但无主动唤醒（Pull-only）；不可用=未安装、未通过验证或已停用。</p>
        </HelpPopover>
      </div>
      <Button type="button" variant="outline" size="sm" :disabled="applications.isFetching.value || pending.length > 0" @click="detect">
        {{ applications.isFetching.value ? '检测中…' : '刷新检测' }}
      </Button>
    </div>
    <p v-if="applications.isPending.value" role="status" class="text-sm text-muted-foreground">正在读取桌面应用状态…</p>
    <Alert v-if="applications.error.value" variant="destructive">
      <AlertDescription>桌面应用状态读取失败，请检查服务连接。
        <Disclosure><template #summary>错误详情</template><pre class="whitespace-pre-wrap break-words">{{ message(applications.error.value) }}</pre></Disclosure>
      </AlertDescription>
    </Alert>
    <Empty v-if="applications.isSuccess.value && !(applications.data.value ?? []).length">
      <EmptyHeader><EmptyTitle>暂无受支持的桌面应用</EmptyTitle><EmptyDescription>受支持的桌面应用为 Codex、DSH 与 Claude。</EmptyDescription></EmptyHeader>
    </Empty>
    <ItemGroup class="gap-2" aria-live="polite">
      <Item v-for="item in applications.data.value ?? []" :key="item.kind" variant="outline" size="sm">
        <ItemContent>
          <ItemTitle>{{ item.label }} 桌面应用</ItemTitle>
          <p v-if="item.engineVersion || item.bundleVersion" class="text-xs text-muted-foreground">
            应用 {{ item.bundleVersion ?? '未知' }} · 内嵌引擎 {{ item.engineVersion ?? '未知' }}
          </p>
          <p v-if="item.reason" class="text-xs text-muted-foreground">{{ item.reason }}</p>
          <Disclosure v-if="item.diagnostics && Object.keys(item.diagnostics).length">
            <template #summary>诊断详情</template>
            <pre class="whitespace-pre-wrap break-words">{{ diagnosticsText(item) }}</pre>
          </Disclosure>
          <Disclosure v-if="item.lifecycleNote"><template #summary>生命周期说明</template><p class="text-xs text-muted-foreground">{{ item.lifecycleNote }}</p></Disclosure>
          <Alert v-if="failures[item.kind]" variant="destructive">
            <AlertDescription>{{ failures[item.kind] }}</AlertDescription>
          </Alert>
          <div v-if="installResult(item.kind)" class="flex flex-col gap-1 rounded-md border p-2 text-xs text-muted-foreground">
            <p>{{ installResult(item.kind)?.nextStep }}</p>
            <ul v-if="installResult(item.kind)?.limitations?.length" class="list-disc pl-4">
              <li v-for="note in installResult(item.kind)?.limitations" :key="note">{{ note }}</li>
            </ul>
            <Disclosure v-if="installResult(item.kind)?.manual && installResult(item.kind)?.mcpConfig">
              <template #summary>粘贴到 DSH Desktop Profile 的 MCP 配置</template>
              <pre class="whitespace-pre-wrap break-words">{{ mcpConfigText(item.kind) }}</pre>
            </Disclosure>
            <p v-if="installResult(item.kind)?.configPath">已写入：<code>{{ installResult(item.kind)?.configPath }}</code></p>
            <p v-if="installResult(item.kind)?.backupPath">配置备份：<code>{{ installResult(item.kind)?.backupPath }}</code></p>
          </div>
        </ItemContent>
        <ItemActions>
          <Badge :variant="badgeVariant(item)">{{ stateBadge(item) }}</Badge>
          <template v-if="item.installed">
            <Button
              type="button" variant="outline" size="sm"
              :disabled="busy(item.kind)"
              @click="verify(item)"
            >
              {{ busy(item.kind) ? '验证中…' : confirming.includes(item.kind) ? '确认消耗额度并验证' : '验证' }}
            </Button>
            <Button type="button" variant="outline" size="sm" :disabled="busy(item.kind)" @click="install(item)">
              {{ busy(item.kind) ? '接入中…' : '重新接入' }}
            </Button>
            <Button v-if="!item.userDisabled" type="button" variant="outline" size="sm" :disabled="busy(item.kind)" @click="disable(item)">停用</Button>
            <Button v-if="item.userDisabled" type="button" variant="outline" size="sm" :disabled="busy(item.kind)" @click="enable(item)">启用</Button>
            <Button type="button" variant="outline" size="sm" :disabled="busy(item.kind)" @click="remove(item)">移除登记</Button>
          </template>
          <Button v-else type="button" variant="outline" size="sm" :disabled="busy(item.kind)" @click="install(item)">
            {{ busy(item.kind) ? '接入中…' : '接入' }}
          </Button>
        </ItemActions>
      </Item>
    </ItemGroup>
  </section>
</template>
