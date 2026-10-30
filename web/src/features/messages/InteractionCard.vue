<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { CircleHelp, CircleCheck, CircleOff, MessageSquareReply } from '@lucide/vue';import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { api } from '@/shared/api/client';
import type { Interaction, InteractionAnswer, InteractionChoicePayload, InteractionKind } from '@/shared/api/raw-types';

const props = defineProps<{ interaction: Interaction }>();

const actionInteractionKinds = new Set(['takeover', 'handback', 'group_create', 'group_add', 'group_delete', 'member_model']);

const queryClient = useQueryClient();
const busy = ref(false);
const draft = ref('');
const inputError = ref('');

watch(
  () => props.interaction.id,
  () => {
    draft.value = '';
    inputError.value = '';
  },
);

const payload = computed(() => props.interaction.payload);
const kind = computed(() => props.interaction.kind);
const isAction = computed(() => actionInteractionKinds.has(kind.value));
const actionLabel = computed(
  () =>
    ({
      takeover: '接管',
      handback: '交还',
      group_create: '建群',
      group_add: '加人',
      group_delete: '删群',
      member_model: '调模',
    } as Partial<Record<InteractionKind, string>>)[kind.value] ?? '',
);
const options = computed(() =>
  kind.value === 'choice'
    ? (payload.value as InteractionChoicePayload).options ?? []
    : [],
);
const answerSummary = computed(() => {
  const answer = props.interaction.answer;
  if (!answer) return '';
  if ('selected' in answer) return answer.selected;
  if ('value' in answer) return answer.value;
  return answer.approved ? '已同意' : '已拒绝';
});

async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['group', props.interaction.group_id] }),
    queryClient.invalidateQueries({ queryKey: ['home-summary'] }),
    queryClient.invalidateQueries({ queryKey: ['interactions', props.interaction.group_id] }),
    queryClient.invalidateQueries({ queryKey: ['interactions', 'panel'] }),
    queryClient.invalidateQueries({ queryKey: ['messages', props.interaction.group_id] }),
  ]);
}

async function decide(answer: InteractionAnswer) {
  if (busy.value) return;
  busy.value = true;
  try {
    await api.answerInteraction(props.interaction.id, answer);
    await refresh();
  } catch (error) {
    toast.error('答复失败', { description: String(error) });
  } finally {
    busy.value = false;
  }
}

const choose = (selected: string) => decide({ selected });
const decideAction = (approved: boolean) => decide({ approved });

async function submitInput() {
  if (busy.value) return;
  const value = draft.value.trim();
  if (!value) {
    inputError.value = '请填写内容后再提交';
    return;
  }
  inputError.value = '';
  await decide({ value });
}
</script>

<template>
  <Item
    variant="outline"
    size="sm"
    class="items-start"
    data-testid="interaction-card"
    :id="`interaction-${interaction.id}`"
    tabindex="-1"
  >
    <ItemMedia variant="icon" class="mt-0.5">
      <CircleCheck v-if="interaction.state === 'answered'" />
      <CircleOff v-else-if="interaction.state === 'cancelled'" />
      <CircleHelp v-else />
    </ItemMedia>
    <ItemContent class="min-w-0">
      <ItemTitle>
        用户互动 · {{ isAction ? actionLabel : kind === 'choice' ? '选择' : '填写' }}
      </ItemTitle>
      <ItemDescription class="line-clamp-none whitespace-pre-wrap wrap-anywhere">
        {{ payload.text }}
      </ItemDescription>
      <template v-if="interaction.state === 'answered'">
        <Badge variant="secondary" class="mt-1 w-fit">
          {{ answerSummary }}
        </Badge>
      </template>
      <template v-else-if="interaction.state === 'failed'">
        <Badge variant="destructive" class="mt-1 w-fit">执行失败</Badge>
        <p v-if="interaction.detail" class="text-xs text-destructive">{{ interaction.detail }}</p>
      </template>
      <template v-else-if="interaction.state === 'cancelled'">
        <Badge variant="outline" class="mt-1 w-fit">已取消</Badge>
      </template>
      <template v-else-if="isAction">
        <div class="flex flex-wrap gap-2 pt-1">
          <Button size="sm" :disabled="busy" @click="decideAction(true)">同意</Button>
          <Button size="sm" variant="outline" :disabled="busy" @click="decideAction(false)">拒绝</Button>
        </div>
      </template>
      <template v-else-if="kind === 'choice'">
        <div class="flex flex-wrap gap-2 pt-1">
          <Button
            class="h-auto max-w-full whitespace-normal break-words py-2 text-left"
            v-for="option in options"
            :key="option"
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="choose(option)"
          >
            {{ option }}
          </Button>
        </div>
      </template>
      <template v-else>
        <div class="flex flex-col gap-2 pt-1">
          <Textarea
            v-model="draft"
            class="min-h-20 bg-background"
            :disabled="busy"
            aria-label="互动卡填写内容"
            @keydown.enter.exact.prevent="submitInput"
          />
          <p v-if="inputError" class="text-xs text-destructive">{{ inputError }}</p>
          <div>
            <Button size="sm" :disabled="busy" @click="submitInput">
              <MessageSquareReply data-icon="inline-start" />
              提交答复
            </Button>
          </div>
        </div>
      </template>
    </ItemContent>
  </Item>
</template>
