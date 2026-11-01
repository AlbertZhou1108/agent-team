<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { useUiStore } from '@/stores/ui';
import { api } from '@/shared/api/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldGroup, Field, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from '@/components/ui/select';
import {
  navigationEntries,
  matchingEntries,
  type SearchEntry,
} from './navigation';
import { usePanelAgentStore } from '@/stores/panel-agent';
const ui = useUiStore();
const router = useRouter();
const term = ref('');
const debounced = ref('');
const group = ref('all');
const member = ref('all');
const from = ref('');
const to = ref('');
const advanced = ref(false);
let timer: ReturnType<typeof setTimeout>;
watch(term, (value) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    debounced.value = value.trim();
  }, 250);
});
watch(
  () => ui.searchOpen,
  (open) => {
    if (open) {
      term.value = '';
      debounced.value = '';
    }
  },
);
const groups = useQuery({
  queryKey: ['groups'],
  queryFn: ({ signal }) => api.groups(signal),
  enabled: computed(() => ui.searchOpen),
});
const directory = useQuery({
  queryKey: ['directory'],
  queryFn: ({ signal }) => api.directory(signal),
  enabled: computed(() => ui.searchOpen),
});
const entries = computed(() => [
  ...navigationEntries,
  ...(groups.data.value ?? []).map((g) => ({
    id: g.id,
    label: g.name,
    path: `/groups/${encodeURIComponent(g.id)}`,
    keywords: `团队 ${g.workspace}`,
  })),
  ...(directory.data.value?.members ?? [])
    .filter((m) => !m.removed)
    .map((m) => ({
      id: m.id,
      label: m.name,
      path: `/groups/${encodeURIComponent(m.group_id)}`,
      keywords: `成员 ${m.host}`,
    })),
]);
const shortcuts = computed(() =>
  matchingEntries(entries.value, term.value).slice(0, 15),
);
const shortcutGroups = computed(() =>
  [
    {
      label: '页面',
      items: shortcuts.value.filter(
        (e) =>
          navigationEntries.some((n) => n.id === e.id) &&
          !e.id.startsWith('setting-'),
      ),
    },
    {
      label: '设置',
      items: shortcuts.value.filter((e) => e.id.startsWith('setting-')),
    },
    {
      label: '团队',
      items: shortcuts.value.filter((e) =>
        (groups.data.value ?? []).some((g) => g.id === e.id),
      ),
    },
    {
      label: '成员',
      items: shortcuts.value.filter((e) =>
        (directory.data.value?.members ?? []).some((m) => m.id === e.id),
      ),
    },
  ].filter((g) => g.items.length),
);
const messages = useQuery({
  queryKey: computed(() => [
    'workspace-search',
    debounced.value,
    group.value,
    member.value,
    from.value,
    to.value,
  ]),
  enabled: computed(() => ui.searchOpen && Boolean(debounced.value)),
  queryFn: async ({ signal }) => {
    const params = new URLSearchParams({ q: debounced.value });
    if (group.value !== 'all') params.set('group', group.value);
    if (member.value !== 'all') params.set('member', member.value);
    if (from.value)
      params.set('from', new Date(`${from.value}T00:00:00`).toISOString());
    if (to.value) {
      const end = new Date(`${to.value}T00:00:00`);
      end.setDate(end.getDate() + 1);
      params.set('to', end.toISOString());
    }
    const response = await fetch(`/api/search?${params}`, { signal });
    if (!response.ok) throw Error('搜索失败');
    return response.json() as Promise<
      Array<{
        id: string;
        text: string;
        groupName: string;
        senderName: string;
        path: string;
        created: string;
      }>
    >;
  },
  refetchOnWindowFocus: false,
});
const recent = ref<SearchEntry[]>([]);
try {
  const value = JSON.parse(
    localStorage.getItem('agent-team:recent-navigation') ?? '[]',
  );
  if (Array.isArray(value))
    recent.value = value
      .filter(
        (v) =>
          typeof v.label === 'string' &&
          typeof v.path === 'string' &&
          v.path.startsWith('/') &&
          !v.path.startsWith('//'),
      )
      .slice(0, 5);
} catch {
  /* optional history */
}
async function open(entry: SearchEntry) {
  const person = directory.data.value?.members.find((m) => m.id === entry.id);
  if (person) {
    try {
      const sessions = await api.sessions(person.group_id);
      const endpoint =
        sessions.endpoints.find(
          (e) => e.member_id === person.id && e.context === 'pair:user',
        ) ?? sessions.endpoints.find((e) => e.member_id === person.id);
      if (endpoint)
        entry = {
          ...entry,
          path: `/groups/${encodeURIComponent(person.group_id)}?session=${encodeURIComponent(endpoint.id)}`,
        };
    } catch {
      /* team remains accessible */
    }
  }
  recent.value = [
    entry,
    ...recent.value.filter((e) => e.path !== entry.path),
  ].slice(0, 5);
  try {
    localStorage.setItem(
      'agent-team:recent-navigation',
      JSON.stringify(recent.value),
    );
  } catch {
    /* optional history */
  }
  ui.searchOpen = false;
  void router.push(entry.path);
}
function createTeam() {
  const panel = usePanelAgentStore();
  if (!panel.draft.trim()) panel.setDraft('请帮我创建一个新团队。');
  open({ id: 'create', label: '创建团队', path: '/agent' });
}
function hotkey(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    ui.searchOpen = !ui.searchOpen;
  }
}
onMounted(() => window.addEventListener('keydown', hotkey));
onBeforeUnmount(() => {
  clearTimeout(timer);
  window.removeEventListener('keydown', hotkey);
});
</script>
<template>
  <Dialog v-model:open="ui.searchOpen">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader
        ><DialogTitle>全局搜索</DialogTitle
        ><DialogDescription
          >搜索页面、设置、团队、成员和消息 · ⌘K / Ctrl+K</DialogDescription
        ></DialogHeader
      >
      <Command :should-filter="false">
        <CommandInput
          :model-value="term"
          placeholder="搜索或跳转…"
          aria-label="全局搜索内容"
          @input="term = ($event.target as HTMLInputElement).value"
        />
        <Button variant="ghost" size="sm" @click="advanced = !advanced">{{
          advanced ? '收起消息筛选' : '消息筛选'
        }}</Button>
        <FieldGroup
          v-if="advanced"
          class="grid grid-cols-1 gap-3 p-2 sm:grid-cols-2"
        >
          <Field
            ><FieldLabel>团队</FieldLabel
            ><Select v-model="group"
              ><SelectTrigger aria-label="搜索团队范围"
                ><SelectValue /></SelectTrigger
              ><SelectContent
                ><SelectGroup
                  ><SelectItem value="all">全部团队</SelectItem
                  ><SelectItem
                    v-for="g in groups.data.value ?? []"
                    :key="g.id"
                    :value="g.id"
                    >{{ g.name }}</SelectItem
                  ></SelectGroup
                ></SelectContent
              ></Select
            ></Field
          >
          <Field
            ><FieldLabel>成员</FieldLabel
            ><Select v-model="member"
              ><SelectTrigger aria-label="搜索成员范围"
                ><SelectValue /></SelectTrigger
              ><SelectContent
                ><SelectGroup
                  ><SelectItem value="all">全部成员</SelectItem
                  ><SelectItem
                    v-for="m in (directory.data.value?.members ?? []).filter(
                      (m) => !m.removed,
                    )"
                    :key="m.id"
                    :value="m.id"
                    >{{ m.name }}</SelectItem
                  ></SelectGroup
                ></SelectContent
              ></Select
            ></Field
          >
          <Field
            ><FieldLabel for="search-from">起始日期</FieldLabel
            ><Input id="search-from" v-model="from" type="date"
          /></Field>
          <Field
            ><FieldLabel for="search-to">截止日期</FieldLabel
            ><Input id="search-to" v-model="to" type="date"
          /></Field>
        </FieldGroup>
        <CommandList>
          <CommandGroup v-if="!term && recent.length" heading="最近访问"
            ><template #heading
              ><Badge variant="secondary">最近访问</Badge></template
            ><CommandItem
              v-for="entry in recent"
              :key="entry.path"
              :value="`recent-${entry.id}`"
              @select="open(entry)"
              >{{ entry.label }}</CommandItem
            ></CommandGroup
          >
          <template
            v-for="(category, index) in shortcutGroups"
            :key="category.label"
          >
            <CommandSeparator v-if="index > 0 || (!term && recent.length)" />
            <CommandGroup :heading="category.label">
              <template #heading
                ><span class="flex items-center justify-between gap-2"
                  ><Badge variant="secondary">{{ category.label }}</Badge
                  ><span>{{ category.items.length }}</span></span
                ></template
              >
              <CommandItem
                v-for="entry in category.items"
                :key="entry.id"
                :value="entry.id"
                @select="open(entry)"
                >{{ entry.label }}</CommandItem
              >
            </CommandGroup>
          </template>
          <CommandGroup v-if="!term || '创建团队'.includes(term)" heading="操作"
            ><template #heading
              ><Badge variant="secondary">操作</Badge></template
            ><CommandItem value="create-team" @select="createTeam"
              >创建团队…</CommandItem
            ></CommandGroup
          >
          <CommandSeparator v-if="term" /><CommandGroup
            v-if="term"
            heading="消息"
            ><template #heading
              ><span class="flex items-center justify-between gap-2"
                ><Badge variant="secondary">消息</Badge
                ><span>{{ messages.data.value?.length ?? 0 }}</span></span
              ></template
            >
            <p
              v-if="messages.isFetching.value || term.trim() !== debounced"
              class="p-3 text-sm text-muted-foreground"
            >
              正在搜索…
            </p>
            <p
              v-else-if="messages.isError.value"
              class="p-3 text-sm text-destructive"
            >
              搜索失败，请重新输入。
            </p>
            <p
              v-else-if="!messages.data.value?.length"
              class="p-3 text-sm text-muted-foreground"
            >
              暂无消息
            </p>
            <CommandItem
              v-for="message in term.trim() === debounced
                ? (messages.data.value ?? [])
                : []"
              :key="message.id"
              :value="message.id"
              @select="
                open({
                  id: message.id,
                  label: message.text.slice(0, 40),
                  path: message.path,
                })
              "
              ><span class="flex min-w-0 flex-col gap-1"
                ><span class="text-xs text-muted-foreground"
                  >{{ message.groupName }} · {{ message.senderName }} ·
                  {{ new Date(message.created).toLocaleDateString() }}</span
                ><span class="line-clamp-2 break-all">{{
                  message.text
                }}</span></span
              ></CommandItem
            >
          </CommandGroup>
        </CommandList>
      </Command>
    </DialogContent>
  </Dialog>
</template>
