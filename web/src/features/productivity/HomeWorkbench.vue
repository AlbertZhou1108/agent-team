<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Disclosure } from '@/components/ui/disclosure';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyDescription } from '@/components/ui/empty';
import MarkdownRenderer from '@/components/ai-elements/MarkdownRenderer.vue';
import { ChevronRight, LoaderCircle, RefreshCw } from '@lucide/vue';
import WorkbenchCleanButton from './WorkbenchCleanButton.vue';
import { useWorkbenchPage } from './use-workbench-page';

/**
 * 工作台：只保留模板与接线。
 * 查询 / 双卡分页状态 / 清理动作 / 摘要流状态全部在 useWorkbenchPage。
 */
const {
  query,
  data,
  inboxTab,
  activityTab,
  pending,
  unread,
  unreadTotal,
  running,
  recent,
  emptyPendingText,
  emptyUnreadText,
  emptyRunningText,
  emptyRecentText,
  confirmClean,
  cleaning,
  cleanError,
  cleanPendingDisabled,
  cleanDescription,
  cleanEntries,
  workbenchOpen,
  confirmCleanActivity,
  cleaningActivity,
  cleanActivityError,
  cleanActivityDisabled,
  cleanRecentActivity,
  error,
  live,
  summarizing,
  summaryStale,
  summaryText,
  summaryPhase,
  elapsed,
  relativeTime,
  shortTime,
  interactionMeta,
  statusMeta,
  pendingSource,
  unreadTitle,
  recentMeta,
  summarize,
} = useWorkbenchPage();
</script>

<template>
  <section class="flex min-w-0 flex-col gap-4" aria-labelledby="workbench-title">
    <Alert v-if="query.isError.value" variant="destructive">
      <AlertDescription>
        工作台加载失败
        <Button variant="outline" size="sm" @click="query.refetch()">重试</Button>
      </AlertDescription>
    </Alert>
    <Disclosure v-model:open="workbenchOpen" :heading-level="2">
      <template #summary><span id="workbench-title">工作台</span></template>
      <template v-if="$slots.actions" #actions><slot name="actions" /></template>
      <div class="flex min-w-0 flex-col gap-4">
        <div class="grid min-w-0 gap-4 lg:grid-cols-2">
          <!-- 左卡：未读（待处理 / 未读消息） -->
          <Card size="compact" class="home-card min-w-0">
            <Tabs v-model="inboxTab" class="flex min-h-0 flex-1 flex-col gap-(--card-gap)">
              <CardHeader class="flex flex-row flex-wrap items-center justify-between gap-3">
                <CardTitle>未读</CardTitle>
                <div class="flex items-center gap-2">
                  <TabsList class="grid w-fit grid-cols-2">
                    <TabsTrigger value="pending">
                      <span>待处理</span>
                      <span
                        v-if="pending.length"
                        data-testid="tab-count-pending"
                        class="rounded-full bg-foreground/10 px-1.5 py-0 text-xs font-medium tabular-nums text-muted-foreground"
                        >{{ pending.length }}</span
                      >
                    </TabsTrigger>
                    <TabsTrigger value="unread">
                      <span>未读消息</span>
                      <span
                        v-if="unreadTotal"
                        data-testid="tab-count-unread"
                        class="rounded-full bg-foreground/10 px-1.5 py-0 text-xs font-medium tabular-nums text-muted-foreground"
                        >{{ unreadTotal }}</span
                      >
                    </TabsTrigger>
                  </TabsList>
                  <WorkbenchCleanButton
                    :disabled="cleanPendingDisabled"
                    :busy="cleaning"
                    label="清理待处理卡片"
                    description="从工作台隐藏待处理卡片（未读消息不受影响）"
                    @click="cleanError = ''; confirmClean = true"
                  />
                </div>
              </CardHeader>
              <CardContent class="home-card-scroll flex min-h-0 flex-1 flex-col border-t pt-2">
                <TabsContent value="pending" class="flex min-h-0 flex-1 flex-col">
                  <Empty v-if="!pending.length">
                    <EmptyDescription>{{ emptyPendingText }}</EmptyDescription>
                  </Empty>
                  <div v-else class="flex flex-col divide-y divide-border/60">
                    <RouterLink
                      v-for="item in pending"
                      :key="item.id"
                      :to="item.path"
                      class="flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="truncate text-sm font-medium text-foreground">{{
                            item.title
                          }}</span>
                          <Badge :variant="interactionMeta(item.interactionKind).variant">
                            {{ interactionMeta(item.interactionKind).label }}
                          </Badge>
                        </span>
                        <span class="truncate text-xs text-muted-foreground">{{
                          pendingSource(item)
                        }}</span>
                      </span>
                      <span class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <span>{{ relativeTime(item.created) }}</span>
                        <ChevronRight class="size-3.5" aria-hidden="true" />
                      </span>
                    </RouterLink>
                  </div>
                </TabsContent>
                <TabsContent value="unread" class="flex min-h-0 flex-1 flex-col">
                  <Empty v-if="!unread.length">
                    <EmptyDescription>{{ emptyUnreadText }}</EmptyDescription>
                  </Empty>
                  <div v-else class="flex flex-col divide-y divide-border/60">
                    <RouterLink
                      v-for="row in unread"
                      :key="row.conversation"
                      :to="row.path"
                      class="flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="truncate text-sm font-medium text-foreground">{{
                          unreadTitle(row)
                        }}</span>
                        <span class="truncate text-xs text-muted-foreground">
                          最后收到于 {{ relativeTime(row.latest) }}
                        </span>
                      </span>
                      <span class="flex shrink-0 items-center gap-2">
                        <Badge variant="default">{{ row.count }} 条未读</Badge>
                        <ChevronRight class="size-3.5 text-muted-foreground" aria-hidden="true" />
                      </span>
                    </RouterLink>
                  </div>
                </TabsContent>
              </CardContent>
            </Tabs>
            <ConfirmDialog
              :open="confirmClean"
              title="清理待处理卡片？"
              :description="cleanDescription"
              confirm-text="清理"
              destructive
              :busy="cleaning"
              :error="cleanError"
              @cancel="confirmClean = false"
              @confirm="cleanEntries"
            />
          </Card>

          <!-- 右卡：执行活动（运行活动 / 最近执行） -->
          <Card size="compact" class="home-card min-w-0">
            <Tabs v-model="activityTab" class="flex min-h-0 flex-1 flex-col gap-(--card-gap)">
              <CardHeader class="flex flex-row flex-wrap items-center justify-between gap-3">
                <CardTitle>执行活动</CardTitle>
                <div class="flex items-center gap-2">
                  <TabsList class="grid w-fit grid-cols-2">
                    <TabsTrigger value="running">
                      <span>运行活动</span>
                      <span
                        v-if="running.length"
                        data-testid="tab-count-running"
                        class="rounded-full bg-foreground/10 px-1.5 py-0 text-xs font-medium tabular-nums text-muted-foreground"
                        >{{ running.length }}</span
                      >
                    </TabsTrigger>
                    <TabsTrigger value="recent">最近执行</TabsTrigger>
                  </TabsList>
                  <WorkbenchCleanButton
                    :disabled="cleanActivityDisabled"
                    :busy="cleaningActivity"
                    label="清理最近执行"
                    description="从工作台隐藏最近执行（不删除执行记录）"
                    @click="cleanActivityError = ''; confirmCleanActivity = true"
                  />
                </div>
              </CardHeader>
              <CardContent class="home-card-scroll flex min-h-0 flex-1 flex-col border-t pt-2">
                <TabsContent value="running" class="flex min-h-0 flex-1 flex-col">
                  <Empty v-if="!running.length">
                    <EmptyDescription>{{ emptyRunningText }}</EmptyDescription>
                  </Empty>
                  <div v-else class="flex flex-col divide-y divide-border/60">
                    <RouterLink
                      v-for="run in running"
                      :key="run.id"
                      :to="run.path"
                      class="flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="truncate text-sm font-medium text-foreground">
                            {{ run.groupName }} · {{ run.name }}
                          </span>
                          <span
                            class="size-2 shrink-0 rounded-full bg-success"
                            role="status"
                            aria-label="运行中"
                          />
                        </span>
                        <span class="truncate text-xs text-muted-foreground">
                          已运行 {{ elapsed(run.created) }} · 排队 {{ run.queued ?? 0 }} 条
                        </span>
                      </span>
                      <ChevronRight
                        class="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </RouterLink>
                  </div>
                </TabsContent>
                <TabsContent value="recent" class="flex min-h-0 flex-1 flex-col">
                  <Empty v-if="!recent.length">
                    <EmptyDescription>{{ emptyRecentText }}</EmptyDescription>
                  </Empty>
                  <div v-else class="flex flex-col divide-y divide-border/60">
                    <RouterLink
                      v-for="run in recent"
                      :key="run.id"
                      :to="run.path"
                      class="flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="truncate text-sm font-medium text-foreground">
                            {{ run.groupName }} · {{ run.name }}
                          </span>
                          <Badge :variant="statusMeta(run.state).variant">
                            {{ statusMeta(run.state).label }}
                          </Badge>
                        </span>
                        <span
                          v-if="recentMeta(run)"
                          class="truncate text-xs text-muted-foreground"
                        >
                          {{ recentMeta(run) }}
                        </span>
                      </span>
                      <span
                        class="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground"
                      >
                        <span>{{ shortTime(run.ended ?? run.created) }}</span>
                        <ChevronRight class="size-3.5" aria-hidden="true" />
                      </span>
                    </RouterLink>
                  </div>
                </TabsContent>
              </CardContent>
            </Tabs>
            <ConfirmDialog
              :open="confirmCleanActivity"
              title="清理最近执行？"
              :description="`将从工作台隐藏当前最近执行的 ${recent.length} 项；执行记录仍保留。`"
              confirm-text="清理"
              destructive
              :busy="cleaningActivity"
              :error="cleanActivityError"
              @cancel="confirmCleanActivity = false"
              @confirm="cleanRecentActivity"
            />
          </Card>
        </div>

        <Card size="compact" class="home-summary-card min-w-0">
          <CardHeader class="flex flex-row items-center justify-between gap-3">
            <CardTitle>进展摘要</CardTitle>
            <div class="flex shrink-0 items-center gap-2">
              <Button
                v-if="data?.panelReady"
                variant="ghost"
                size="icon-sm"
                :disabled="summarizing"
                :aria-label="summarizing ? summaryPhase : '刷新摘要'"
                :title="summarizing ? summaryPhase : '刷新摘要'"
                @click="summarize"
              >
                <LoaderCircle v-if="summarizing" class="animate-spin" />
                <RefreshCw v-else />
              </Button>
            </div>
          </CardHeader>
          <CardContent
            v-if="error || summaryText || !summarizing"
            class="home-card-scroll flex min-h-0 flex-1 flex-col gap-3"
          >
            <Alert v-if="error" variant="destructive">
              <AlertDescription>{{ error }}</AlertDescription>
            </Alert>
            <template v-if="summaryText">
              <p
                v-if="!summarizing && !live.stream?.text && data?.summary"
                class="text-xs text-muted-foreground"
              >
                生成于 {{ new Date(data.summary.created).toLocaleString() }}
                <template v-if="summaryStale">
                  · 摘要已超过一天，可能过期，可点击右上角刷新
                </template>
              </p>
              <div role="region" aria-label="进展摘要内容" tabindex="0">
                <MarkdownRenderer :content="summaryText" :defer="live.active" />
              </div>
            </template>
            <p v-else-if="!summarizing" class="text-sm text-muted-foreground">
              点击刷新图标，汇总全部团队的近期进展。
            </p>
          </CardContent>
        </Card>
      </div>
    </Disclosure>
  </section>
</template>
