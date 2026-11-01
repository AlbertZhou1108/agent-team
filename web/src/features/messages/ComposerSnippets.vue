<script setup lang="ts">
import { computed, ref } from 'vue';
import { TextQuote } from '@lucide/vue';
import { useSnippets } from '@/stores/snippets';
import { InputGroupButton } from '@/components/ui/input-group';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { FieldGroup, Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
const props = defineProps<{ currentText: string }>();
const emit = defineEmits<{ insert: [text: string] }>();
const store = useSnippets();
const open = ref(false);
const editing = ref(false);
defineExpose({
  show: () => {
    open.value = true;
  },
});
const id = ref('');
const name = ref('');
const text = ref('');
const items = computed(() => [...store.items].sort((a, b) => b.used - a.used));
function edit(item?: { id: string; name: string; text: string }) {
  open.value = false;
  id.value = item?.id ?? '';
  name.value = item?.name ?? '';
  text.value = item?.text ?? props.currentText;
  editing.value = true;
}
function save() {
  store.save(id.value, name.value, text.value);
  editing.value = false;
}
</script>
<template>
  <Popover v-model:open="open"
    ><PopoverTrigger as-child
      ><InputGroupButton
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="常用片段"
        title="常用片段"
        ><TextQuote /></InputGroupButton></PopoverTrigger
    ><PopoverContent class="w-80" align="end">
      <div class="flex flex-col gap-2">
        <p class="text-sm font-medium">常用片段</p>
        <div class="flex max-h-64 flex-col gap-1 overflow-y-auto">
          <div
            v-for="item in items"
            :key="item.id"
            class="flex min-w-0 items-center gap-1"
          >
            <Button
              type="button"
              variant="ghost"
              class="min-w-0 flex-1 justify-start"
              @click="
                store.use(item.id);
                emit('insert', item.text);
                open = false;
              "
              ><span class="truncate">{{ item.name }}</span></Button
            ><Button type="button" variant="ghost" size="sm" @click="edit(item)"
              >编辑</Button
            >
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" @click="edit()"
          >新建片段</Button
        >
      </div>
    </PopoverContent></Popover
  >
  <Dialog v-model:open="editing"
    ><DialogContent
      ><DialogHeader
        ><DialogTitle>{{
          id ? '编辑片段' : '新建片段'
        }}</DialogTitle></DialogHeader
      ><FieldGroup
        ><Field
          ><FieldLabel for="snippet-name">名称</FieldLabel
          ><Input id="snippet-name" v-model="name" maxlength="80" /></Field
        ><Field
          ><FieldLabel for="snippet-text">内容</FieldLabel
          ><Textarea
            id="snippet-text"
            v-model="text"
            rows="6"
            maxlength="12000" /></Field></FieldGroup
      ><DialogFooter
        ><Button
          v-if="id"
          type="button"
          variant="destructive"
          @click="
            store.remove(id);
            editing = false;
          "
          >删除</Button
        ><Button type="button" variant="outline" @click="editing = false"
          >取消</Button
        ><Button
          type="button"
          :disabled="!name.trim() || !text.trim()"
          @click="save"
          >保存</Button
        ></DialogFooter
      ></DialogContent
    ></Dialog
  >
</template>
