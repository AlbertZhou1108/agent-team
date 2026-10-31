<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { api } from '@/shared/api/client';
import type { AttachmentSettings } from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { queryKeys } from '@/features/query-keys';

// 附件上传设置:界面用 MiB / 个 / MP 展示,提交前换算回字节/像素/个数;
// 服务端在上传与消息提交时执行最终校验,这里的前端校验只为及时提示。
const MIB = 1024 * 1024;
const MP = 1_000_000;

const settingsQuery = useQuery({
  queryKey: queryKeys.attachmentSettings,
  queryFn: ({ signal }) => api.attachmentSettings(signal),
});

const maxFileMib = ref('');
const maxFiles = ref('');
const maxImageMp = ref('');
const saving = ref(false);
const serverError = ref('');
const fieldErrors = ref({ maxFileBytes: '', maxFilesPerMessage: '', maxImagePixels: '' });

// 只用首次载入的数据初始化输入;保存成功后以响应为准重新同步。
watch(() => settingsQuery.data.value, (value: AttachmentSettings | undefined) => {
  if (!value) return;
  maxFileMib.value = trimNumber(value.maxFileBytes / MIB);
  maxFiles.value = String(value.maxFilesPerMessage);
  maxImageMp.value = trimNumber(value.maxImagePixels / MP);
}, { immediate: true });

function trimNumber(value: number) {
  return String(Number(value.toFixed(6)));
}

function parsePositiveNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// 换算后必须是正整数(字节/像素取整,个数必须本身就是整数),并落在服务端认可的范围内。
function validateFields() {
  const errors = { maxFileBytes: '', maxFilesPerMessage: '', maxImagePixels: '' };
  const mib = parsePositiveNumber(maxFileMib.value);
  if (mib === null) errors.maxFileBytes = '请输入正数,单位 MiB';
  else {
    const bytes = Math.round(mib * MIB);
    if (bytes <= 0 || bytes > 2 ** 31 - 1) errors.maxFileBytes = '换算后需为 1 字节到 2 GiB 之间的整数';
  }
  const files = Number(maxFiles.value);
  if (!maxFiles.value.trim() || !Number.isFinite(files) || !Number.isInteger(files) || files <= 0) errors.maxFilesPerMessage = '请输入正整数';
  else if (files > 100) errors.maxFilesPerMessage = '最多 100 个';
  const mp = parsePositiveNumber(maxImageMp.value);
  if (mp === null) errors.maxImagePixels = '请输入正数,单位 MP';
  else {
    const pixels = Math.round(mp * MP);
    if (pixels <= 0 || pixels > 2 ** 31 - 1) errors.maxImagePixels = '换算后需为 1 像素到 2147 MP 之间的整数';
  }
  fieldErrors.value = errors;
  return !errors.maxFileBytes && !errors.maxFilesPerMessage && !errors.maxImagePixels;
}

const parsedDraft = computed(() => ({
  maxFileBytes: Math.round(Number(maxFileMib.value) * MIB),
  maxFilesPerMessage: Number(maxFiles.value),
  maxImagePixels: Math.round(Number(maxImageMp.value) * MP),
}));

const hasChanges = computed(() => {
  const value = settingsQuery.data.value;
  if (!value) return false;
  const draft = parsedDraft.value;
  return draft.maxFileBytes !== value.maxFileBytes
    || draft.maxFilesPerMessage !== value.maxFilesPerMessage
    || draft.maxImagePixels !== value.maxImagePixels;
});

const canSave = computed(() => hasChanges.value && !saving.value);

async function save() {
  if (!canSave.value || !validateFields()) return;
  saving.value = true;
  serverError.value = '';
  try {
    await api.updateAttachmentSettings(parsedDraft.value);
    await settingsQuery.refetch();
    toast.success('附件设置已保存');
  } catch (cause) {
    serverError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-sm font-semibold">附件上传</h3>
        <p class="mt-1 text-xs text-muted-foreground">
          Panel Agent 私人会话支持发送 TXT 与 PNG;限制同时约束前端选择与服务端校验。
        </p>
      </div>
      <Button v-if="hasChanges" size="sm" :disabled="!canSave" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </Button>
    </div>

    <FieldGroup class="grid gap-3 sm:grid-cols-3">
      <Field :data-invalid="fieldErrors.maxFileBytes || undefined">
        <FieldLabel for="attachment-max-file">单文件最大大小</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id="attachment-max-file"
            v-model="maxFileMib"
            inputmode="decimal"
            autocomplete="off"
            @blur="hasChanges && validateFields()"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>MiB</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription>默认 5 MiB。</FieldDescription>
        <FieldError v-if="fieldErrors.maxFileBytes">{{ fieldErrors.maxFileBytes }}</FieldError>
      </Field>

      <Field :data-invalid="fieldErrors.maxFilesPerMessage || undefined">
        <FieldLabel for="attachment-max-files">单条消息最大附件数</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id="attachment-max-files"
            v-model="maxFiles"
            inputmode="numeric"
            autocomplete="off"
            @blur="hasChanges && validateFields()"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>个</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription>默认 4 个。</FieldDescription>
        <FieldError v-if="fieldErrors.maxFilesPerMessage">{{ fieldErrors.maxFilesPerMessage }}</FieldError>
      </Field>

      <Field :data-invalid="fieldErrors.maxImagePixels || undefined">
        <FieldLabel for="attachment-max-pixels">图片最大像素数</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id="attachment-max-pixels"
            v-model="maxImageMp"
            inputmode="decimal"
            autocomplete="off"
            @blur="hasChanges && validateFields()"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>MP</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription>默认 20 MP。</FieldDescription>
        <FieldError v-if="fieldErrors.maxImagePixels">{{ fieldErrors.maxImagePixels }}</FieldError>
      </Field>
    </FieldGroup>
    <p v-if="serverError" class="text-xs text-destructive" role="alert">{{ serverError }}</p>
  </div>
</template>
