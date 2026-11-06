<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/shared/api/client';
import { formatNoteTime } from './notes-state';

/**
 * 随心记的快捷输入:right-popover 挂载的内容组件。
 * 只做「记一笔」这一件事 —— 写下正文就落库,完整整理在随心记页面里做。
 *
 * 在团队上下文里挂载时,groupId 就是这条笔记的**来源团队**（不是归属）:
 * 记完能立刻看到本团队最近几条,要看全部再去随心记页面。
 */
const props = defineProps<{ groupId?: string }>();

const client = useQueryClient();
const router = useRouter();
const body = ref('');
const busy = ref(false);
const canSave = computed(() => body.value.trim().length > 0);
const teamId = computed(() => props.groupId ?? null);

const recent = useQuery({
  queryKey: computed(() => ['notes', 'team', teamId.value] as const),
  queryFn: ({ signal }) => api.notes({ team: teamId.value!, state: 'active', limit: 5 }, signal),
  enabled: computed(() => Boolean(teamId.value)),
  refetchInterval: 15000,
  refetchOnWindowFocus: false,
});
const recentNotes = computed(() => recent.data.value?.notes ?? []);

async function refresh() {
  // 与 NotesWorkspace 同一套失效谓词:列表与单条都可能是缓存起点。
  await Promise.all([
    client.invalidateQueries({ predicate: query => String(query.queryKey[0]) === 'notes' }),
    client.invalidateQueries({ predicate: query => String(query.queryKey[0]) === 'note' }),
  ]);
}

async function save() {
  const text = body.value.trim();
  if (!text || busy.value) return;
  busy.value = true;
  try {
    await api.createNote({
      id: crypto.randomUUID(),
      body: text,
      ...(teamId.value ? { sourceTeamId: teamId.value } : {}),
    });
    body.value = '';
    await refresh();
    toast.success('已记下来');
  } catch (cause) {
    toast.error('记笔记失败', { description: String(cause) });
  } finally {
    busy.value = false;
  }
}

function openNote(id: string) {
  if (!teamId.value) return;
  void router.push({ name: 'notes', query: { team: teamId.value, note: id } });
}

function openAll() {
  if (!teamId.value) return;
  void router.push({ name: 'notes', query: { team: teamId.value } });
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3" :data-attached-group="props.groupId ? 'true' : undefined">
    <Textarea
      v-model="body"
      class="min-h-24 bg-background"
      placeholder="想到什么就写下来……"
      aria-label="快速记一笔"
      @keydown.enter.exact.prevent="save"
    />
    <div class="flex items-center justify-between gap-2">
      <p class="text-xs text-muted-foreground">Enter 保存，完整整理去随心记页面。</p>
      <Button size="sm" :disabled="!canSave || busy" @click="save">
        <LoaderCircle v-if="busy" class="animate-spin" />
        记下来
      </Button>
    </div>

    <!-- 这个团队还没有笔记时整块不出现：空状态的「最近」和「查看全部」都没有意义。 -->
    <section v-if="recentNotes.length" class="flex flex-col gap-1">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted-foreground">本团队最近</span>
        <Button variant="link" size="sm" class="h-auto p-0 text-xs" @click="openAll">查看全部</Button>
      </div>
      <ul class="flex flex-col">
        <li v-for="note in recentNotes" :key="note.id">
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2 rounded-(--component-control-radius) px-2 py-1.5 text-start transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            @click="openNote(note.id)"
          >
            <span class="min-w-0 flex-1 truncate text-sm">{{ note.title || '无标题' }}</span>
            <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ formatNoteTime(note.updated) }}</span>
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
