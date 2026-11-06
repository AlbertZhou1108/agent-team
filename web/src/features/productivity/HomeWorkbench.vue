<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Disclosure } from '@/components/ui/disclosure';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyDescription } from '@/components/ui/empty';
import MarkdownRenderer from '@/components/ai-elements/MarkdownRenderer.vue';
import { LoaderCircle, RefreshCw } from '@lucide/vue';
import WorkbenchCleanButton from './WorkbenchCleanButton.vue';
import { useWorkbenchPage } from './use-workbench-page';

/**
 * 工作台：只保留模板与接线。
 * 查询 / 待办合并与过滤 / 清理动作 / 摘要流状态全部在 useWorkbenchPage。
 */
const {
  query, data, filter, entries, emptyText, selectedLabel, sourceLabel, confirmClean,
  cleaning, cleanError, cleanDescription, cleanEntries, workbenchOpen,
  confirmCleanActivity, cleaningActivity, cleanActivityError,
  cleanRecentActivity, activityTab, error, live, summarizing, summaryStale,
  summaryText, summaryPhase, elapsed, privateBusy, statusLabels, summarize,
} = useWorkbenchPage();
</script>

<template>
  <section class="flex min-w-0 flex-col gap-4" aria-labelledby="workbench-title">
    <Alert v-if="query.isError.value" variant="destructive"
      ><AlertDescription
        >工作台加载失败
        <Button variant="outline" size="sm" @click="query.refetch()"
          >重试</Button
        ></AlertDescription
      ></Alert
    >
    <Disclosure v-model:open="workbenchOpen" :heading-level="2">
      <template #summary><span id="workbench-title">工作台</span></template>
      <template v-if="$slots.actions" #actions><slot name="actions" /></template>
      <div class="flex min-w-0 flex-col gap-4">
        <div class="grid min-w-0 gap-4 lg:grid-cols-2">
      <Card size="compact" class="home-card min-w-0">
        <CardHeader class="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle
            >待处理
            <Badge variant="secondary">{{ entries.length }}</Badge></CardTitle
          >
          <div class="flex min-w-0 items-center gap-2">
            <Select v-model="filter">
              <SelectTrigger class="w-36" aria-label="选择待处理范围"
                ><span data-slot="select-value" class="min-w-0 truncate">{{
                  selectedLabel
                }}</span></SelectTrigger
              >
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="interaction"
                  >待你处理</SelectItem
                >
                <SelectItem value="user"
                  >等待回复</SelectItem
                >
                <SelectItem value="agent"
                  >Agent 等待</SelectItem
                >
              </SelectContent>
            </Select>
            <WorkbenchCleanButton
              :disabled="!entries.length"
              :busy="cleaning"
              label="清理当前列表"
              description="从工作台隐藏当前列表（不删除消息）"
              @click="cleanError = ''; confirmClean = true"
            />
          </div>
        </CardHeader>
        <CardContent class="home-card-scroll flex min-h-0 flex-1 flex-col gap-3">
          <Empty v-if="!entries.length"
            ><EmptyDescription>{{ emptyText }}</EmptyDescription></Empty
          >
          <div v-else class="flex flex-col gap-2">
            <Button
              v-for="item in entries"
              :key="`${item.source}:${item.id}`"
              as-child
              variant="ghost"
              class="h-auto justify-start"
              ><RouterLink :to="item.path"
                ><span class="flex min-w-0 flex-col gap-1"
                  ><span class="flex flex-wrap items-center gap-2"
                    ><Badge variant="outline">{{ sourceLabel[item.source] }}</Badge
                    ><span class="text-xs text-muted-foreground"
                      >{{ item.groupName
                      }}<template v-if="item.source === 'agent'">
                        · {{ item.senderName }} → {{ item.recipientName }}</template
                      ><template v-else-if="item.source === 'user'">
                        · {{ item.recipientName }}</template
                      ></span
                    ></span
                  ><span
                    class="line-clamp-2 whitespace-normal break-all text-left"
                    >{{ item.title }}</span
                  ><span
                    v-if="item.source !== 'interaction'"
                    class="text-xs text-muted-foreground"
                    >已等待 {{ elapsed(item.created) }}</span
                  ></span
                ></RouterLink
              ></Button
            >
          </div>
        </CardContent>
        <ConfirmDialog
          :open="confirmClean"
          title="清理当前待处理项？"
          :description="cleanDescription"
          confirm-text="清理"
          destructive
          :busy="cleaning"
          :error="cleanError"
          @cancel="confirmClean = false"
          @confirm="cleanEntries"
        />
      </Card>
          <Card size="compact" class="home-card min-w-0">
            <Tabs v-model="activityTab" class="flex min-h-0 flex-1 flex-col gap-(--card-gap)">
              <CardHeader class="flex flex-row flex-wrap items-center justify-between gap-3">
                <CardTitle>执行活动</CardTitle>
                <div class="flex items-center gap-2"><TabsList class="grid w-fit grid-cols-2">
                  <TabsTrigger value="running">运行活动</TabsTrigger>
                  <TabsTrigger value="recent">最近执行</TabsTrigger>
                </TabsList><WorkbenchCleanButton v-if="activityTab === 'recent'" :disabled="!data?.recent.length" :busy="cleaningActivity" label="清理最近执行" description="从工作台隐藏最近执行（不删除执行记录）" @click="cleanActivityError = ''; confirmCleanActivity = true" /></div>
              </CardHeader>
              <CardContent class="home-card-scroll flex min-h-0 flex-1 flex-col gap-3">
                <TabsContent value="running" class="flex min-h-0 flex-1 flex-col gap-3">
                  <Empty v-if="!data?.running.length"
                    ><EmptyDescription>{{
                      query.isPending.value ? '正在加载…' : '暂无运行中的成员'
                    }}</EmptyDescription></Empty
                  >
                  <Button
                    v-for="run in data?.running ?? []"
                    :key="run.id"
                    as-child
                    variant="ghost"
                    class="h-auto justify-start"
                    ><RouterLink :to="run.path"
                      ><span class="flex w-full min-w-0 flex-col gap-1"
                        ><span class="truncate"
                          >{{ run.groupName }} · {{ run.name }}</span
                        ><span class="text-xs text-muted-foreground"
                          >已运行 {{ elapsed(run.created) }} · 排队
                          {{ run.queued ?? 0 }} 条</span
                        ></span
                      ></RouterLink
                    ></Button
                  >
                </TabsContent>
                <TabsContent value="recent" class="flex min-h-0 flex-1 flex-col gap-1">
                  <div class="flex max-h-64 flex-col gap-1 overflow-y-auto">
                    <Button
                      v-for="run in data?.recent ?? []"
                      :key="run.id"
                      as-child
                      variant="ghost"
                      class="h-auto justify-start"
                      ><RouterLink :to="run.path"
                        ><span class="flex min-w-0 flex-col gap-1"
                          ><span class="truncate"
                            >{{ run.groupName }} · {{ run.name }}</span
                          ><span class="text-xs text-muted-foreground"
                            >{{ statusLabels[run.state ?? ''] ?? run.state }} ·
                            {{
                              new Date(run.ended ?? run.created).toLocaleString()
                            }}</span
                          ></span
                        ></RouterLink
                      ></Button
                    >
                    <p
                      v-if="!data?.recent.length"
                      class="text-sm text-muted-foreground"
                    >
                      暂无数据
                    </p>
                  </div>
                </TabsContent>
              </CardContent>
            </Tabs><ConfirmDialog :open="confirmCleanActivity" title="清理最近执行？" :description="`将从工作台隐藏当前最近执行的 ${data?.recent.length ?? 0} 项；执行记录仍保留。`" confirm-text="清理" destructive :busy="cleaningActivity" :error="cleanActivityError" @cancel="confirmCleanActivity = false" @confirm="cleanRecentActivity" />
          </Card>
        </div>
    <Card size="compact" class="home-card min-w-0">
      <CardHeader class="flex flex-row items-center justify-between gap-3">
        <CardTitle>进展摘要</CardTitle>
        <div class="flex shrink-0 items-center gap-2">
          <Button
            v-if="data?.panelReady"
            variant="ghost"
            size="icon-sm"
            :disabled="summarizing || privateBusy"
            :aria-label="summarizing ? '正在刷新摘要' : '刷新摘要'"
            :title="privateBusy ? 'Panel Agent 正在运行' : '刷新摘要'"
            @click="summarize"
          >
            <LoaderCircle v-if="summarizing" class="animate-spin" /><RefreshCw
              v-else
            />
          </Button>
        </div>
      </CardHeader>
      <CardContent class="home-card-scroll flex min-h-0 flex-1 flex-col gap-3">
        <Alert v-if="error" variant="destructive"
          ><AlertDescription>{{ error }}</AlertDescription></Alert
        >
        <p
          v-if="summarizing"
          class="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle class="size-4 animate-spin" />{{ summaryPhase }}
        </p>
        <template v-if="summaryText"
          ><p
            v-if="!summarizing && !live.stream?.text && data?.summary"
            class="text-xs text-muted-foreground"
          >
            生成于 {{ new Date(data.summary.created).toLocaleString()
            }}<template v-if="summaryStale"
              > · 摘要已超过一天，可能过期，可点击右上角刷新</template
            >
          </p>
          <div
            role="region"
            aria-label="进展摘要内容"
            tabindex="0"
          >
            <MarkdownRenderer
              :content="summaryText"
              :defer="live.active"
            /></div
        ></template>
        <p v-else-if="!summarizing" class="text-sm text-muted-foreground">
          {{
            summarizing || privateBusy
              ? '摘要生成后会显示在这里。'
              : '点击刷新图标，汇总全部团队的近期进展。'
          }}
        </p>
      </CardContent></Card
    >
      </div>
    </Disclosure>
  </section>
</template>
