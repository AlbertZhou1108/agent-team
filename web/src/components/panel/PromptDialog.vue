<script setup lang="ts">
import { ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    required?: boolean;
  }>(),
  {
    description: '',
    placeholder: '',
    confirmText: '确认',
    cancelText: '取消',
    destructive: false,
    required: true,
  },
);

const emit = defineEmits<{
  confirm: [value: string];
  cancel: [];
}>();

const value = ref('');

watch(
  () => props.open,
  (open) => {
    if (open) value.value = '';
  },
);

function submit() {
  const text = value.value.trim();
  if (props.required && !text) return;
  emit('confirm', text);
}
</script>

<template>
  <Dialog
    :open="open"
    @update:open="
      (next) => {
        if (!next) emit('cancel');
      }
    "
  >
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="description">
          {{ description }}
        </DialogDescription>
      </DialogHeader>
      <Textarea
        v-model="value"
        :placeholder="placeholder"
        rows="3"
        @keydown.enter.exact.prevent="submit"
        @keydown.ctrl.enter="submit"
        @keydown.meta.enter="submit"
      />
      <DialogFooter>
        <Button variant="outline" @click="emit('cancel')">{{ cancelText }}</Button>
        <Button
          :variant="destructive ? 'destructive' : 'default'"
          :disabled="required && !value.trim()"
          @click="submit"
        >
          {{ confirmText }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
