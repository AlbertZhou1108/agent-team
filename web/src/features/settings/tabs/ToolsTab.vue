<script setup lang="ts">
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { BUILTIN_TOOLS, TOOL_SLOT_LABELS } from '@/tools';
import { usePreferencesStore } from '@/stores/preferences';

const preferences = usePreferencesStore();
</script>

<template>
          <section class="flex flex-col gap-3 pt-6">
            <p class="text-xs text-muted-foreground">
              工具是面板里的功能模块：总开关一键禁用，也可以单独控制在各个位置的显示。内置工具随应用发布，未来可安装外部工具。
            </p>
            <div class="mt-1 divide-y divide-border">
            <div
              v-for="tool in BUILTIN_TOOLS"
              :key="tool.id"
              class="flex flex-col gap-3 py-3 first:pt-0"
              :class="{ 'opacity-60': preferences.toolModules.disabled[tool.id] }"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="flex min-w-0 items-start gap-2.5">
                  <component :is="tool.icon" v-if="tool.icon" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <h3 class="text-sm font-semibold">{{ tool.name }}</h3>
                      <Badge variant="outline">{{ tool.scope === 'global' ? '全局' : '团队' }}</Badge>
                    </div>
                    <p v-if="tool.description" class="mt-0.5 text-xs text-muted-foreground">{{ tool.description }}</p>
                  </div>
                </div>
                <Switch
                  :model-value="!preferences.toolModules.disabled[tool.id]"
                  class="shrink-0"
                  :aria-label="`启用${tool.name}`"
                  @update:model-value="preferences.setToolEnabled(tool.id, Boolean($event))"
                />
              </div>
              <!-- 挂载级开关:每个位置独立显示/隐藏。 -->
              <div class="flex flex-col gap-1.5">
                <div
                  v-for="mount in tool.mounts"
                  :key="mount.slot"
                  class="flex items-center justify-between gap-3"
                >
                  <span class="text-xs text-muted-foreground">{{ TOOL_SLOT_LABELS[mount.slot] }}</span>
                  <Switch
                    :model-value="!preferences.toolModules.hidden[`${tool.id}:${mount.slot}`]"
                    class="shrink-0"
                    :aria-label="`显示「${tool.name}」的${TOOL_SLOT_LABELS[mount.slot]}`"
                    @update:model-value="preferences.setMountHidden(tool.id, mount.slot, !Boolean($event))"
                  />
                </div>
              </div>
            </div>
            </div>
          </section>
</template>
