<script setup lang="ts">
import { ref } from 'vue';
import { Play } from '@lucide/vue';

// 微缩会话样例:导航面板/会话头部/消息区/输入区分别挂 data-material-sample
// 钩子,与真实表面消费同一份材质/密度规则;正文走 markdown-content 消费阅读设置。
// 动效演示:重挂载"新消息"气泡重播入场动画,时长跟随当前动效风格。
const demoKey = ref(0);
</script>

<template>
  <div class="appearance-sample" aria-hidden="true">
    <div class="appearance-sample-nav" data-material-sample="nav">
      <span class="appearance-sample-dot"></span>
      <span>导航面板</span>
    </div>
    <div class="appearance-sample-main">
      <div class="appearance-sample-header" data-material-sample="header">会话操作区</div>
      <div class="appearance-sample-stream">
        <div class="appearance-sample-row">
          <span class="appearance-sample-avatar"></span>
          <div class="markdown-content appearance-sample-text">正文与代码 `ok` 也会跟随阅读设置。</div>
        </div>
        <div class="appearance-sample-row">
          <span class="appearance-sample-avatar"></span>
          <div class="markdown-content appearance-sample-text">切换材质、密度后立即在这里预览。</div>
        </div>
        <div v-if="demoKey > 0" :key="demoKey" class="appearance-sample-chip">新消息</div>
      </div>
      <div class="appearance-sample-composer" data-material-sample="composer">
        <span class="inline-flex items-center gap-2">
          <span class="loading-dots"><i></i><i></i><i></i></span>
          <span>输入区</span>
        </span>
        <button type="button" class="appearance-sample-replay" @click="demoKey++">
          <Play class="size-3" />
          <span>预览动效</span>
        </button>
      </div>
    </div>
  </div>
</template>
