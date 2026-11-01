<script setup lang="ts">
import type { Component } from 'vue';
import type { SurfaceRole } from '@/theme/materials';

/**
 * 语义层的表面载体:容器类角色由使用场景赋予(role 必填,取值类型化自
 * theme/materials.ts 的角色注册表),组件内部写 data-surface 并按角色
 * 消费 --surface-{role}-* 变量(消费规则见 styles/globals.css 材质段)。
 * 未传合法 role 无法通过类型检查 —— "天然实现设计"的机制本体。
 * 控件类角色(按钮/输入框等)不经过本组件,由 ui/ 原语就地进化承担。
 */
withDefaults(
  defineProps<{
    /** 表面角色,由使用场景赋予容器类表面。 */
    role: SurfaceRole;
    /** 渲染为哪个元素或组件,默认 div;属性透传到其根元素。 */
    as?: string | Component;
  }>(),
  { as: 'div' },
);
</script>

<template>
  <component :is="as" :data-surface="role">
    <slot />
  </component>
</template>
