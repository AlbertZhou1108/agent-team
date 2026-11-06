<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  CircleHelp,
  CircleOff,
  ListChecks,
  MessageSquareReply,
  Send,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
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
import { motionDurationMs } from '@/shared/motion';
import type {
  Interaction,
  InteractionAnswer,
  InteractionChoicePayload,
  InteractionFlowPayload,
  InteractionFlowStep,
  InteractionFlowSubmission,
  InteractionKind,
} from '@/shared/api/raw-types';

const props = defineProps<{
  interaction: Interaction;
  /** 卡片成为消息本体时,用它补回「谁在什么时候发起」;有锚点气泡时由气泡承担,不传。 */
  anchor?: { senderName: string; createdAt: string };
}>();

const actionInteractionKinds = new Set(['takeover', 'handback', 'group_create', 'group_add', 'group_delete', 'member_model']);

const queryClient = useQueryClient();
const busy = ref(false);
const draft = ref('');
const inputError = ref('');
/** 多步卡片:一次只显示一题,本地收集后整卡提交。 */
const active = ref(0);
const stepDrafts = ref<Record<number, { selected?: string; value?: string }>>({});
const submitError = ref('');
const direction = ref<'next' | 'back'>('next');
/** 「答完自动进下一题」的延时器:换卡或卸载时清掉,避免把别的题翻走。 */
let advanceTimer: ReturnType<typeof setTimeout> | null = null;
function clearAdvance() {
  if (advanceTimer) clearTimeout(advanceTimer);
  advanceTimer = null;
}
onBeforeUnmount(clearAdvance);

watch(
  () => props.interaction.id,
  () => {
    clearAdvance();
    draft.value = '';
    inputError.value = '';
    active.value = 0;
    stepDrafts.value = {};
    submitError.value = '';
  },
);

const payload = computed(() => props.interaction.payload);
const kind = computed(() => props.interaction.kind);
const isAction = computed(() => actionInteractionKinds.has(kind.value));
const isFlow = computed(() => kind.value === 'flow');
const flowSteps = computed<InteractionFlowStep[]>(() =>
  isFlow.value ? ((payload.value as InteractionFlowPayload).steps ?? []) : [],
);
const currentStep = computed(() => flowSteps.value[active.value]);
const stepCount = computed(() => flowSteps.value.length);
const stepNumber = computed(() => active.value + 1);
// 打开卡片时停第一道没答的题(老数据可能带部分答复),否则从头开始。
watch(
  () => props.interaction.id,
  () => {
    const first = flowSteps.value.findIndex(step => !step.answer);
    active.value = first < 0 ? 0 : first;
  },
  { immediate: true },
);
/** 整卡标题与首题重复时不再多占一行。 */
const headline = computed(() => {
  const text = payload.value.text?.trim();
  if (!isFlow.value) return text ?? '';
  return text && text !== flowSteps.value[0]?.text?.trim() ? text : '';
});
const actionLabel = computed(
  () =>
    ({
      takeover: '接管',
      handback: '交还',
      group_create: '建群',
      group_add: '加人',
      group_delete: '删群',
      member_model: '调模',
      flow: '问答',
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
  if ('answers' in answer) return `已完成 ${answer.answers.length} 步`;
  return answer.approved ? '已同意' : '已拒绝';
});
const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const anchorLabel = computed(() => {
  if (!props.anchor) return '';
  const time = new Date(props.anchor.createdAt);
  return `${props.anchor.senderName} · ${Number.isNaN(time.getTime()) ? '' : timeFormatter.format(time)}`;
});
/** 进入位移的方向跟着前进后退走,经自定义属性传给过渡样式。 */
const stepShift = computed(() => (direction.value === 'back' ? '-12px' : '12px'));
const answeredCount = computed(() => flowSteps.value.filter((_step, index) => isAnswered(index)).length);

function stepDraft(index: number) {
  return stepDrafts.value[index] ?? {};
}
/** 旧版本可能已存下部分答复:本地没改过就沿用已存的,避免整卡提交时被判空。 */
function choiceValue(index: number) {
  return stepDraft(index).selected ?? flowSteps.value[index]?.answer?.selected ?? '';
}
function textValue(index: number) {
  return stepDraft(index).value ?? flowSteps.value[index]?.answer?.value ?? '';
}
function isAnswered(index: number) {
  if (flowSteps.value[index]?.answer) return true;
  const item = stepDraft(index);
  return Boolean(item.selected || item.value?.trim());
}
function pick(index: number, option: string) {
  stepDrafts.value = { ...stepDrafts.value, [index]: { selected: option } };
  submitError.value = '';
  // 选择题点完就直接进下一题:先让选中态落屏一个内容出现档的时长,再切题。
  if (index >= stepCount.value - 1) return;
  clearAdvance();
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    go(index + 1);
  }, motionDurationMs('normal'));
}
function typeText(index: number, value: string) {
  stepDrafts.value = { ...stepDrafts.value, [index]: { value } };
  submitError.value = '';
}
function go(target: number) {
  if (target < 0 || target >= stepCount.value || target === active.value) return;
  direction.value = target > active.value ? 'next' : 'back';
  active.value = target;
  submitError.value = '';
}
const goBack = () => go(active.value - 1);
const goNext = () => go(active.value + 1);

async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['group', props.interaction.group_id] }),
    queryClient.invalidateQueries({ queryKey: ['home-summary'] }),
    queryClient.invalidateQueries({ queryKey: ['interactions', props.interaction.group_id] }),
    queryClient.invalidateQueries({ queryKey: ['interactions', 'panel'] }),
    queryClient.invalidateQueries({ queryKey: ['messages', props.interaction.group_id] }),
  ]);
}

async function decide(answer: InteractionAnswer | InteractionFlowSubmission) {
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

/** 整卡提交:任一题未答就跳到它并提示,不做半套投递。 */
async function submitFlow() {
  if (busy.value) return;
  const missing = flowSteps.value.findIndex((_step, index) => !isAnswered(index));
  if (missing >= 0) {
    direction.value = missing > active.value ? 'next' : 'back';
    active.value = missing;
    submitError.value = `第 ${missing + 1} 题还没回答`;
    return;
  }
  submitError.value = '';
  const answers = flowSteps.value.map((step, index) =>
    step.kind === 'choice'
      ? { selected: choiceValue(index) }
      : { value: textValue(index) },
  );
  await decide({ answers });
}

/** 单步答复文本:用于已提交后的问答清单。 */
function stepAnswerText(step: InteractionFlowStep) {
  const answer = step.answer ?? {};
  if ('selected' in answer) return answer.selected ?? '';
  return answer.value ?? '';
}

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
      <ListChecks v-else-if="isFlow" />
      <CircleHelp v-else />
    </ItemMedia>
    <ItemContent class="min-w-0">
      <p v-if="anchorLabel" class="text-xs text-muted-foreground tabular-nums">{{ anchorLabel }}</p>
      <ItemTitle>
        用户互动 · {{ isAction ? actionLabel : kind === 'choice' ? '选择' : kind === 'input' ? '填写' : '问答' }}
        <Badge v-if="isFlow && interaction.state === 'pending'" variant="outline">
          第 {{ stepNumber }} / {{ stepCount }} 题
        </Badge>
      </ItemTitle>
      <ItemDescription v-if="isFlow && headline" class="line-clamp-none whitespace-pre-wrap wrap-anywhere">
        {{ headline }}
      </ItemDescription>

      <!-- 多步:待答复时一题一屏;答复后平铺问答记录,不再分步。 -->
      <template v-if="isFlow">
        <template v-if="interaction.state === 'pending'">
          <div class="interaction-step" :style="{ '--step-shift': stepShift }">
            <Transition name="step-swap" mode="out-in">
              <div :key="active" class="flex flex-col gap-2 pt-1">
                <p class="text-sm leading-normal whitespace-pre-wrap wrap-anywhere">{{ currentStep?.text }}</p>
                <div v-if="currentStep?.kind === 'choice'" class="flex flex-wrap gap-2">
                  <Button
                    v-for="option in currentStep.options ?? []"
                    :key="option"
                    class="h-auto max-w-full whitespace-normal break-words py-2 text-left"
                    size="sm"
                    :variant="choiceValue(active) === option ? 'default' : 'outline'"
                    :aria-pressed="choiceValue(active) === option"
                    :disabled="busy"
                    @click="pick(active, option)"
                  >
                    {{ option }}
                  </Button>
                </div>
                <div v-else class="flex flex-col gap-2">
                  <Textarea
                    :model-value="textValue(active)"
                    class="min-h-16 bg-background"
                    :disabled="busy"
                    :aria-label="`第 ${stepNumber} 题`"
                    @update:model-value="typeText(active, String($event))"
                  />
                </div>
              </div>
            </Transition>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div class="flex items-center gap-1.5" role="group" aria-label="问题进度">
              <button
                v-for="(step, index) in flowSteps"
                :key="index"
                type="button"
                class="interaction-step-dot"
                :data-state="index === active ? 'current' : isAnswered(index) ? 'answered' : 'pending'"
                :aria-label="`查看第 ${index + 1} 题`"
                @click="go(index)"
              />
            </div>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="sm" :disabled="busy || active === 0" @click="goBack">
                <ArrowLeft data-icon="inline-start" />
                上一题
              </Button>
              <Button v-if="active < stepCount - 1" size="sm" :disabled="busy" @click="goNext">
                下一题
                <ArrowRight data-icon="inline-end" />
              </Button>
              <Button v-else size="sm" :disabled="busy" @click="submitFlow">
                <Send data-icon="inline-start" />
                提交全部
              </Button>
            </div>
          </div>
          <p v-if="submitError" class="text-xs text-destructive">{{ submitError }}</p>
          <p v-else-if="answeredCount" class="text-xs text-muted-foreground tabular-nums">
            已答 {{ answeredCount }} / {{ stepCount }} 题
          </p>
        </template>

        <template v-else>
          <div class="flex flex-col gap-2.5">
            <div v-for="(step, index) in flowSteps" :key="index" class="flex flex-col gap-1">
              <p class="text-sm leading-normal whitespace-pre-wrap wrap-anywhere">{{ step.text }}</p>
              <p class="border-l border-border pl-2 text-sm leading-normal text-muted-foreground whitespace-pre-wrap wrap-anywhere">{{ step.answer ? stepAnswerText(step) : '未作答' }}</p>
            </div>
          </div>
          <Badge
            v-if="interaction.state === 'cancelled'"
            variant="outline"
            class="mt-1 w-fit"
          >已取消</Badge>
          <template v-else-if="interaction.state === 'failed'">
            <Badge variant="destructive" class="mt-1 w-fit">执行失败</Badge>
            <p v-if="interaction.detail" class="text-xs text-destructive">{{ interaction.detail }}</p>
          </template>
        </template>
      </template>

      <template v-else>
        <!-- 单问卡与多步卡共用同一套记录样式:问题用正文色,答复用左侧细边 + 次要色。 -->
        <p class="text-sm leading-normal whitespace-pre-wrap wrap-anywhere">{{ payload.text }}</p>
        <template v-if="interaction.state === 'answered'">
          <p class="border-l border-border pl-2 text-sm leading-normal text-muted-foreground whitespace-pre-wrap wrap-anywhere">
            {{ answerSummary }}
          </p>
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
      </template>
    </ItemContent>
  </Item>
</template>

<style scoped>
/* 切题只做一次方向性淡入:离场用微反馈档快速让位,进入用内容出现档减速停稳,
   总时长约 370ms;方向由 --step-shift 承载,前进从右、后退从左。 */
.step-swap-enter-active {
  transition:
    opacity var(--component-content-duration) var(--component-content-easing),
    transform var(--component-content-duration) var(--component-content-easing);
}

.step-swap-leave-active {
  transition: opacity var(--component-feedback-duration) var(--component-content-easing);
}

.step-swap-enter-from {
  opacity: 0;
  transform: translateX(var(--step-shift, 12px));
}

.step-swap-leave-to {
  opacity: 0;
}

.interaction-step-dot {
  padding: 0;
  border: 0;
  block-size: 6px;
  inline-size: 6px;
  border-radius: 999px;
  background: var(--border);
  transition:
    inline-size var(--component-feedback-duration) var(--component-content-easing),
    background-color var(--component-feedback-duration) var(--component-content-easing);
}

.interaction-step-dot[data-state='answered'] {
  background: color-mix(in oklch, var(--primary) 55%, transparent);
}

.interaction-step-dot[data-state='current'] {
  inline-size: 16px;
  background: var(--primary);
}

.interaction-step-dot:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
</style>
