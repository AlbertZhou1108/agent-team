<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ArrowLeft, LoaderCircle } from '@lucide/vue';
import { api } from '@/shared/api/client';
import type { Group } from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Disclosure } from '@/components/ui/disclosure';
import MarkdownRenderer from '@/components/ai-elements/MarkdownRenderer.vue';

const props = defineProps<{ team: Group }>();
defineEmits<{ back: [] }>();
const requested = ref(false);
const starting = ref(false);
const error = ref('');
const messagesOpen = ref(false);
const root = ref<HTMLElement>();
const taskLabels = { doing: '进行中', done: '已完成', dropped: '已放弃' };
const interactionLabels: Record<string, string> = { pending: '待处理', answered: '已答复', cancelled: '已取消', failed: '失败' };
const query = useQuery({
  queryKey: ['archive-snapshot', props.team.id],
  queryFn: ({ signal }) => api.archiveSnapshot(props.team.id, signal),
  retry: false,
  gcTime: 0,
  refetchOnWindowFocus: false,
  refetchInterval: query => query.state.data?.generating ? 1000 : false,
});
const snapshot = query.data;
async function generate() {
  if (starting.value) return;
  requested.value = true;
  starting.value = true;
  error.value = '';
  try {
    await api.summarizeArchive(props.team.id);
    await query.refetch();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '摘要生成失败';
  } finally {
    starting.value = false;
  }
}
watch(snapshot, value => {
  if (value && !value.summary && !value.generating && !value.error && !requested.value) void generate();
}, { immediate: true });
function name(id: string) {
  if (id === 'user') return '用户';
  if (id === 'system') return '系统';
  return snapshot.value?.facts.members.find(member => member.id === id)?.name
    ?? (snapshot.value?.facts.panelAgent?.id === id ? snapshot.value.facts.panelAgent.name : id);
}
async function followSource(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest('a');
  const href = link?.getAttribute('href');
  if (!href?.startsWith('#archive-message-')) return;
  event.preventDefault();
  messagesOpen.value = true;
  await nextTick();
  root.value?.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({ block: 'nearest' });
}
</script>

<template>
  <section ref="root" class="flex min-w-0 flex-col gap-4 pt-6" aria-label="归档快照" @click="followSource">
    <div class="flex flex-wrap items-center gap-3">
      <Button variant="ghost" size="sm" @click="$emit('back')"><ArrowLeft data-icon="inline-start" />返回归档团队</Button>
      <h3 class="min-w-0 break-words text-sm font-semibold">{{ team.name }} · 归档快照</h3>
    </div>
    <p v-if="query.isPending.value" role="status">正在读取快照…</p>
    <Alert v-else-if="query.isError.value" variant="destructive">
      <AlertDescription>{{ query.error.value?.message }}<Button variant="outline" size="sm" @click="query.refetch()">重试</Button></AlertDescription>
    </Alert>
    <template v-else-if="snapshot">
      <p class="text-xs text-muted-foreground">归档于 {{ new Date(snapshot.created).toLocaleString() }}</p>
      <p v-if="starting || snapshot.generating" class="flex items-center gap-2 text-sm" role="status"><LoaderCircle class="size-4 animate-spin" />Panel Agent 正在生成摘要…</p>
      <Alert v-if="error || snapshot.error" variant="destructive">
        <AlertDescription>{{ error || snapshot.error }}<Button variant="outline" size="sm" :disabled="starting || snapshot.generating" @click="generate">重试生成</Button></AlertDescription>
      </Alert>
      <MarkdownRenderer v-if="snapshot.summary" :content="snapshot.summary" />
      <Disclosure>
        <template #summary>团队与任务清单</template>
        <p v-if="snapshot.facts.group.charter" class="whitespace-pre-wrap break-words">{{ snapshot.facts.group.charter }}</p>
        <p v-for="member in snapshot.facts.members" :key="member.id">{{ member.name }} · {{ member.host }}{{ member.removed ? ' · 已移除' : '' }}</p>
        <div v-for="task in snapshot.facts.tasks" :key="task.owner_id" class="flex flex-col gap-1">
          <strong class="text-sm">{{ name(task.owner_id) }} · 成员自述</strong>
          <p v-for="(item, index) in task.tasks" :key="index" class="break-words text-sm">{{ taskLabels[item.state] }} · {{ item.text }}</p>
        </div>
      </Disclosure>
      <Disclosure :open="messagesOpen" @update:open="messagesOpen = $event">
        <template #summary>来源消息（{{ snapshot.facts.messages.length }}）</template>
        <div class="flex flex-col gap-4">
          <article v-for="message in snapshot.facts.messages" :id="`archive-message-${message.id}`" :key="message.id" class="flex min-w-0 flex-col gap-1">
            <p class="break-words text-xs text-muted-foreground">{{ name(message.sender) }} → {{ name(message.recipient) }} · {{ new Date(message.created).toLocaleString() }}</p>
            <p class="whitespace-pre-wrap break-words text-sm">{{ message.text }}</p>
          </article>
        </div>
      </Disclosure>
      <Disclosure v-if="snapshot.facts.panelMessages.length || snapshot.facts.interactions.length">
        <template #summary>其他记录</template>
        <div v-for="message in snapshot.facts.panelMessages" :key="message.id" class="flex flex-col gap-1">
          <p class="text-xs text-muted-foreground">Panel Agent · {{ message.role }} · {{ new Date(message.created).toLocaleString() }}</p>
          <p class="whitespace-pre-wrap break-words text-sm">{{ message.text }}</p>
        </div>
        <div v-for="interaction in snapshot.facts.interactions" :key="interaction.id" class="flex flex-col gap-1">
          <p class="text-xs text-muted-foreground">{{ interactionLabels[interaction.state] ?? interaction.state }} · {{ new Date(interaction.created).toLocaleString() }}</p>
          <p class="whitespace-pre-wrap break-words text-sm">{{ interaction.payload.text || '团队操作' }}</p>
          <p v-if="interaction.payload.options?.length" class="break-words text-sm">选项：{{ interaction.payload.options.join(' / ') }}</p>
          <p v-if="interaction.answer" class="whitespace-pre-wrap break-words text-sm">答复：{{ interaction.answer.value ?? interaction.answer.selected ?? (interaction.answer.approved === true ? '同意' : interaction.answer.approved === false ? '拒绝' : '已记录') }}</p>
        </div>
      </Disclosure>
    </template>
    <p v-else class="text-sm text-muted-foreground">暂无快照；恢复后再次归档会创建快照。</p>
  </section>
</template>
