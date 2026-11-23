<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { NoteBlock } from '@/components/ui/note-block';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { PolicyMode } from '@/features/groups/create-team-model';
import { POLICY_MODES, isPolicyMode, policyRank } from '@/features/groups/create-team-model';
import { api } from '@/shared/api/client';
import type { Member } from '@/shared/api/raw-types';
import type { MemberPolicyUpdate } from '@/shared/api/client';

/**
 * 调整单个成员的权限上限与工具授权。
 * 下拉只列群策略以内的档位；不虚构能力，生效值以 API 返回的 capabilityCard 为准。
 */
const props = defineProps<{
  member: Member | null;
  groupPolicy?: string | null;
  groupAllowShell?: boolean;
}>();

const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{
  saved: [member: Member];
}>();

const INHERIT = '__inherit__';
const CEILING_LABELS: Record<PolicyMode, string> = {
  communication: '仅通信',
  'read-only': '只读',
  'workspace-write': '可写',
};

function ceilingLabel(value: string | null | undefined): string {
  return isPolicyMode(value) ? CEILING_LABELS[value] : '未知';
}

const form = ref({ policyCeiling: INHERIT, allowShell: false, allowBrowser: false });
const initial = ref({ ceiling: null as string | null, allowShell: false, allowBrowser: false });
const busy = ref(false);
const saveError = ref('');

const groupCeiling = computed<PolicyMode | null>(() => (isPolicyMode(props.groupPolicy) ? props.groupPolicy : null));

const ceilingOptions = computed<PolicyMode[]>(() => {
  const ceiling = groupCeiling.value;
  if (!ceiling) return [];
  return POLICY_MODES.filter((mode) => policyRank(mode) <= policyRank(ceiling));
});

const inheritedLabel = computed(() => (
  groupCeiling.value
    ? `继承群策略（${CEILING_LABELS[groupCeiling.value]}）`
    : '继承群策略（群策略未同步）'
));

const effectiveCeiling = computed<PolicyMode | null>(() => {
  if (form.value.policyCeiling === INHERIT) return groupCeiling.value;
  return isPolicyMode(form.value.policyCeiling) ? form.value.policyCeiling : null;
});

const shellDisabled = computed(() => busy.value || props.groupAllowShell === false
  || (effectiveCeiling.value !== null && effectiveCeiling.value !== 'workspace-write'));
const browserDisabled = computed(() => busy.value || effectiveCeiling.value === 'communication');

const shellHint = computed(() => {
  const ceiling = effectiveCeiling.value;
  if (ceiling === 'communication') return '仅通信策略不能执行命令。';
  if (ceiling === 'read-only') return '只读策略不能执行命令。';
  if (props.groupAllowShell === false) return '群策略未允许执行命令，成员级开关不会生效。';
  if (props.member?.allow_shell == null) return '当前继承群设置：群允许命令时生效。关闭后该成员按只读环境运行。';
  return '允许该成员执行命令；关闭后按只读环境运行。';
});

const browserHint = computed(() => {
  if (effectiveCeiling.value === 'communication') return '仅通信策略下不能开启浏览器 / Computer Use。';
  return '非 Codex 宿主需探测到可用浏览器 MCP 才实际生效；Codex 授权后解除原生浏览器 / Computer Use / 看图禁用。';
});

const currentSummary = computed(() => {
  if (!props.member) return '';
  const policy = props.member.capabilityCard?.effectivePolicy;
  if (!policy) return '能力未同步';
  const mode = ceilingLabel(policy.mode);
  return policy.ceiling ? `生效 ${mode}（请求上限 ${ceilingLabel(policy.ceiling)}）` : `生效 ${mode}`;
});

function resetForm() {
  const member = props.member;
  if (!member) return;
  const requested = isPolicyMode(member.policy_ceiling) ? member.policy_ceiling : null;
  // 群策略收紧后旧的请求上限可能越界，或群策略尚未同步时，界面先按继承展示，
  // 避免出现不在选项列表里的值；真正保存时以用户的新选择为准。
  const inRange = requested !== null
    && groupCeiling.value !== null
    && policyRank(requested) <= policyRank(groupCeiling.value);
  const effectiveCeilingValue = inRange ? requested : groupCeiling.value;
  // 继承群设置（allow_shell 为 null）时按当前实际继承值初始化开关状态，
  // 否则原本启用的命令权限会显示为关闭，导致用户无法一键关掉它。
  const initialAllowShell = member.allow_shell === null || member.allow_shell === undefined
    ? (props.groupAllowShell !== false && effectiveCeilingValue === 'workspace-write')
    : member.allow_shell === 1;
  form.value = {
    policyCeiling: inRange ? requested : INHERIT,
    allowShell: initialAllowShell,
    allowBrowser: member.allow_browser === 1,
  };
  initial.value = {
    ceiling: member.policy_ceiling ?? null,
    allowShell: initialAllowShell,
    allowBrowser: member.allow_browser === 1,
  };
  saveError.value = '';
}

watch(
  () => [open.value, props.member?.id, props.groupPolicy] as const,
  ([isOpen]) => {
    if (!isOpen) return;
    resetForm();
  },
  { immediate: true },
);

function onCeilingChange(value: unknown) {
  if (busy.value) return;
  form.value.policyCeiling = String(value);
}

function setShell(value: unknown) {
  if (!shellDisabled.value) form.value.allowShell = Boolean(value);
}
function setBrowser(value: unknown) {
  if (!browserDisabled.value) form.value.allowBrowser = Boolean(value);
}

const nextBody = computed<MemberPolicyUpdate>(() => {
  const body: MemberPolicyUpdate = {};
  const nextCeiling = form.value.policyCeiling === INHERIT ? null : form.value.policyCeiling;
  if (nextCeiling !== initial.value.ceiling) body.policyCeiling = nextCeiling;
  // 非可写档位下本就不能执行命令；仅收紧策略上限时不额外覆写成员原有 allow_shell（保留继承 null）。
  if (effectiveCeiling.value === 'workspace-write' && form.value.allowShell !== initial.value.allowShell) {
    body.allowShell = form.value.allowShell;
  }
  if (effectiveCeiling.value !== 'communication') {
    if (form.value.allowBrowser !== initial.value.allowBrowser) body.allowBrowser = form.value.allowBrowser;
  } else if (initial.value.allowBrowser) {
    body.allowBrowser = false;
  }
  return body;
});
const hasChanges = computed(() => Object.keys(nextBody.value).length > 0);

async function submit() {
  if (!props.member || busy.value || !hasChanges.value) return;
  busy.value = true;
  saveError.value = '';
  try {
    const { member } = await api.updateMemberPolicy(props.member.group_id, props.member.id, nextBody.value);
    toast.success(`已更新 ${props.member.name} 的权限`);
    emit('saved', member);
    open.value = false;
  } catch (error) {
    // 服务端拒绝（运行中 / 越级 / 归档）就在弹窗内说明，保留用户的选择。
    saveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(value) => (open = value)">
    <DialogContent v-if="member" class="max-w-lg" data-testid="member-policy-dialog">
      <DialogHeader>
        <DialogTitle>调整权限 · {{ member.name }}</DialogTitle>
        <DialogDescription>
          当前：{{ currentSummary }}。权限与工具只影响该成员后续回合，不改变群策略上限。
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-4">
        <Alert v-if="saveError" variant="destructive" data-testid="member-policy-error">
          <AlertDescription>{{ saveError }}</AlertDescription>
        </Alert>

        <Field>
          <FieldLabel :for="`member-policy-ceiling-${member.id}`">成员策略上限</FieldLabel>
          <Select
            :model-value="form.policyCeiling"
            :disabled="busy"
            data-testid="member-policy-ceiling"
            @update:model-value="onCeilingChange"
          >
            <SelectTrigger :id="`member-policy-ceiling-${member.id}`" aria-label="成员策略上限">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem :value="INHERIT">{{ inheritedLabel }}</SelectItem>
                <SelectItem v-for="mode in ceilingOptions" :key="mode" :value="mode">{{ CEILING_LABELS[mode] }}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>只能比群策略更严；群策略调严时自动收敛。</FieldDescription>
        </Field>

        <Field>
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1 space-y-1">
              <FieldLabel :for="`member-policy-shell-${member.id}`">允许执行命令</FieldLabel>
              <FieldDescription>{{ shellHint }}</FieldDescription>
            </div>
            <Switch
              :id="`member-policy-shell-${member.id}`"
              data-testid="member-policy-shell"
              :model-value="shellDisabled ? false : form.allowShell"
              :disabled="shellDisabled"
              aria-label="允许执行命令"
              @update:model-value="setShell"
            />
          </div>
        </Field>

        <Field>
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1 space-y-1">
              <FieldLabel :for="`member-policy-browser-${member.id}`">允许浏览器 / Computer Use</FieldLabel>
              <FieldDescription>{{ browserHint }}</FieldDescription>
            </div>
            <Switch
              :id="`member-policy-browser-${member.id}`"
              data-testid="member-policy-browser"
              :model-value="browserDisabled ? false : form.allowBrowser"
              :disabled="browserDisabled"
              aria-label="允许浏览器与 Computer Use"
              @update:model-value="setBrowser"
            />
          </div>
        </Field>

        <NoteBlock size="sm" data-testid="member-policy-session-note">
          调整权限或工具将清理该成员现有宿主会话，下一轮以新环境启动。
        </NoteBlock>
      </div>

      <DialogFooter class="flex-row justify-between gap-2 sm:justify-between">
        <Button variant="outline" :disabled="busy" @click="open = false">取消</Button>
        <Button
          :disabled="busy || !hasChanges"
          :title="!hasChanges ? '没有需要保存的变更' : undefined"
          data-testid="member-policy-save"
          @click="submit"
        >
          {{ busy ? '保存中…' : '保存调整' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
