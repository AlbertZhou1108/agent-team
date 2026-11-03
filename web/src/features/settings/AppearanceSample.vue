<script setup lang="ts">
import { ref } from 'vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Surface } from '@/components/surface';
import { CollapseReveal } from '@/components/ui/collapse-reveal';
import SidebarEntry from '@/app/layouts/SidebarEntry.vue';
const open = ref(true);
const enabled = ref(true);
const disabled = ref(false);
</script>

<template>
  <div class="appearance-sample" aria-label="设计预设组件预览">
    <Surface role="nav-panel" class="flex min-w-0 flex-col gap-2 rounded-lg border p-2">
      <SidebarEntry title="预览导航" current>导航项</SidebarEntry>
      <SidebarEntry title="预览分组" :expanded="open" controls="appearance-sample-disclosure" @activate="open = !open">分组</SidebarEntry>
      <CollapseReveal id="appearance-sample-disclosure" :show="open"><span class="px-2 text-xs text-muted-foreground">分组内容</span></CollapseReveal>
    </Surface>
    <div class="flex min-w-0 flex-col gap-2">
      <Surface role="action" class="relative rounded-lg border p-3"><span class="text-sm">会话操作区</span></Surface>
      <Card size="compact"><CardContent class="text-sm">内容表面</CardContent></Card>
      <ToggleGroup presentation="segmented" type="single" model-value="on" variant="outline" aria-label="状态预览">
        <ToggleGroupItem value="on">选中</ToggleGroupItem>
        <ToggleGroupItem value="off">未选</ToggleGroupItem>
      </ToggleGroup>
      <div class="flex flex-wrap items-center gap-2">
        <Input class="min-w-0 flex-1" aria-label="预览输入框" placeholder="输入框" />
        <Button size="sm" @click="open = !open">{{ open ? '收起' : '展开' }}</Button>
      </div>
      <div class="flex flex-wrap items-center gap-2" aria-label="按钮与状态预览">
        <Button>主按钮</Button>
        <Button variant="secondary">次级</Button>
        <Button variant="ghost">轻量</Button>
        <Button variant="destructive">删除</Button>
        <Button variant="outline" disabled>禁用</Button>
        <Badge variant="secondary">待处理</Badge>
      </div>
      <div class="flex items-center gap-4 text-sm" aria-label="开关预览">
        <label class="flex items-center gap-2">
          <Switch v-model="enabled" aria-label="预览开关" />
          <span>开启</span>
        </label>
        <label class="flex items-center gap-2">
          <Switch v-model="disabled" disabled aria-label="预览禁用开关" />
          <span class="text-muted-foreground">禁用开关</span>
        </label>
      </div>
    </div>
  </div>
</template>
