<script setup lang="ts">
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

withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    busy?: boolean;
    error?: string;
  }>(),
  {
    description: '',
    confirmText: '确认',
    cancelText: '取消',
    destructive: false,
    busy: false,
    error: '',
  },
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!value && !busy) emit('cancel');
      }
    "
  >
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="description" class="whitespace-pre-line">
          {{ description }}
        </DialogDescription>
      </DialogHeader>
      <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>
      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="emit('cancel')">{{ cancelText }}</Button>
        <Button
          :disabled="busy"
          :variant="destructive ? 'destructive' : 'default'"
          @click="emit('confirm')"
        >
          {{ busy ? '正在处理…' : confirmText }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
