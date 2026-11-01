<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

import type { TelemetryMetrics } from '@/shared/api/raw-types';
import { compactNumber } from './visuals';
type Team = { id:string;name:string;status:string;metrics:TelemetryMetrics;expectedTurns:number;tokenBatches:number };
type Overview = { generatedAt:string;counts:{teams:number;members:number;running:number};totals:TelemetryMetrics;coverage:{expectedTurns:number;tokenBatches:number;missingTurns:number};teams:Team[];series:{from:string;to:string;batchCount:number;metrics:TelemetryMetrics}[];states:{state:string;count:number}[];scope:string;timeBasis:string };
const emit=defineEmits<{select:[id:string]}>();
const days=ref(1);
const overviewOpen=ref(true);
function selectedRange(){const now=new Date();const start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-(days.value-1));return{from:start.toISOString(),to:now.toISOString(),bucket:days.value===1?'hour':'day'}}
const query=useQuery({queryKey:computed(()=>['telemetry-overview',days.value]),queryFn:async({signal})=>{const response=await fetch('/api/telemetry/overview?'+new URLSearchParams(selectedRange()),{signal});if(!response.ok)throw Error(await response.text());return response.json() as Promise<Overview>},refetchInterval:15000,refetchOnWindowFocus:false});
const data=computed(()=>query.data.value);
const seriesRows=computed(()=>data.value?.series??[]);
const selectedFrom = ref<string | null>(null);
const hoveredFrom = ref<string | null>(null);
watch(days, () => { selectedFrom.value = null; hoveredFrom.value = null; });
const overviewActive = computed(() => hoveredFrom.value === null && selectedFrom.value === null);
const overviewTotals = computed(() => {
  const series = seriesRows.value;
  if (!series.length) return null;
  const values = series.map(point => point.metrics.totalTokens.value).filter((value): value is number => typeof value === 'number');
  return {
    from: series[0]!.from,
    to: series.at(-1)!.to,
    sum: values.reduce((sum, value) => sum + value, 0),
    complete: series.every(point => point.metrics.totalTokens.completeness === 'complete'),
    batches: series.reduce((sum, point) => sum + point.batchCount, 0),
    observed: values.length > 0,
  };
});
const activePoint = computed(() => {
  if (overviewActive.value) return null;
  return seriesRows.value.find(point => point.from === (hoveredFrom.value ?? selectedFrom.value)) ?? null;
});
function togglePoint(from: string) {
  selectedFrom.value = selectedFrom.value === from ? null : from;
  hoveredFrom.value = null;
}
function period(point: { from: string; to: string }) {
  if (days.value === 1) return `${time(point.from)} – ${time(point.to)}`;
  const partial = Date.parse(point.to) - Date.parse(point.from) < 86400000;
  return `${time(point.from)}${partial ? ` · 截至 ${new Date(point.to).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}`;
}
function pointLabel(point: NonNullable<typeof activePoint.value>) {
  const metric = point.metrics.totalTokens;
  return `${period(point)}，${metric.value === null ? '暂无 Token 观测' : `${Number(metric.value).toLocaleString()} Token，${metric.completeness === 'complete' ? '采集完整' : '采集不完整'}`}，${point.batchCount} 个观测回合`;
}
function movePoint(index: number, step: number, event: KeyboardEvent) {
  const series = seriesRows.value;
  const next = Math.max(0, Math.min(series.length - 1, index + step));
  if (!series[next]) return;
  selectedFrom.value = series[next].from;
  const items = (event.currentTarget as Element).parentElement?.querySelectorAll<SVGElement>('[data-trend-bucket]');
  items?.[next]?.focus();
}
const ranks=computed(()=>[...(data.value?.teams??[])].sort((a,b)=>(b.metrics.totalTokens.value??-1)-(a.metrics.totalTokens.value??-1)));
const max=computed(()=>Math.max(1,...ranks.value.map(t=>Number(t.metrics.totalTokens.value??0))));
const observedPeak=computed(()=>{const values=(data.value?.series??[]).flatMap(t=>typeof t.metrics.totalTokens.value==='number'?[t.metrics.totalTokens.value]:[]);return values.length?Math.max(...values):null});
const peak=computed(()=>Math.max(1,observedPeak.value??0));
const labels:Record<string,string>={archived:'已归档',blocked:'待核实／阻塞',running:'运行中',confirmation:'待确认',completed:'已完成',waiting:'等待中'};
function number(value:unknown){return typeof value==='number'?compactNumber(value):'—'}
function time(value:string){return new Date(value).toLocaleString(undefined,days.value===1?{hour:'2-digit',minute:'2-digit'}:{month:'numeric',day:'numeric'})}
</script>
<template>
  <section class="flex min-w-0 flex-col gap-4" aria-label="全局数据总览">
    <Disclosure :heading-level="2" v-model:open="overviewOpen" >
<template #summary>数据总览</template>
<template #actions><ToggleGroup type="single" :model-value="String(days)" aria-label="统计时间范围" @update:model-value="value => { if (value) days = Number(value); }"><ToggleGroupItem v-for="n in [1,7,30]" :key="n" :value="String(n)">{{n===1?'今天':`近 ${n} 天`}}</ToggleGroupItem></ToggleGroup></template>
<div class="flex min-w-0 flex-col gap-6">
    <p v-if="query.isPending.value" class="text-sm text-muted-foreground">正在汇总数据…</p>
    <Alert v-else-if="query.isError.value" variant="destructive"><AlertDescription>汇总加载失败<Button variant="outline" size="sm" @click="query.refetch()">重试</Button></AlertDescription></Alert>
    <template v-if="data">
      <dl class="grid grid-cols-2 gap-4 sm:grid-cols-4"><div v-for="item in [{label:'团队',value:data.counts.teams},{label:'成员',value:data.counts.members},{label:'运行中回合',value:data.counts.running},{label:'已观测 Token',value:data.totals.totalTokens.value}]" :key="item.label" class="flex flex-col gap-1"><dt class="text-xs text-muted-foreground">{{item.label}}</dt><dd class="text-2xl font-semibold tabular-nums">{{number(item.value)}}</dd></div></dl>
      <div class="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card size="compact" class="min-w-0"><CardHeader><CardTitle>消耗趋势</CardTitle></CardHeader><CardContent class="flex min-w-0 flex-col gap-3">
          <div v-if="overviewActive && overviewTotals" class="flex flex-wrap items-start justify-between gap-3" aria-live="polite" aria-atomic="true" data-testid="trend-selection">
            <div class="flex flex-col gap-1"><span class="text-xs text-muted-foreground">{{time(overviewTotals.from)}} – {{time(overviewTotals.to)}} · 整个时间轴</span><span class="font-medium tabular-nums">{{overviewTotals.observed?`${overviewTotals.sum.toLocaleString()} Token`:'暂无 Token 观测'}}</span><span class="text-xs text-muted-foreground">共 {{overviewTotals.batches}} 个观测回合{{overviewTotals.complete?'':' · 采集不完整'}}；点击柱形可查看单时段</span></div>
          </div>
          <div v-else-if="activePoint" class="flex flex-wrap items-start justify-between gap-3" aria-live="polite" aria-atomic="true" data-testid="trend-selection">
            <div class="flex flex-col gap-1"><span class="text-xs text-muted-foreground">{{period(activePoint)}}</span><span class="font-medium tabular-nums">{{activePoint.metrics.totalTokens.value===null?'暂无 Token 观测':`${Number(activePoint.metrics.totalTokens.value).toLocaleString()} Token`}}</span><span class="text-xs text-muted-foreground">再次点击该柱形可返回整轴统计</span></div>
          </div>
          <p class="text-xs text-muted-foreground">峰值 {{number(observedPeak)}}</p>
          <svg viewBox="0 0 600 150" class="w-full text-primary" role="group" aria-label="交互消耗趋势，选择时段查看数据，可使用左右方向键" @mouseleave="hoveredFrom=null">
            <g v-for="(point,i) in data.series" :key="point.from" data-trend-bucket role="button" tabindex="0"
              :aria-label="pointLabel(point)" :aria-pressed="selectedFrom===point.from"
              class="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring"
              @mouseenter="hoveredFrom=point.from" @focus="hoveredFrom=point.from" @blur="hoveredFrom=null"
              @click="togglePoint(point.from)" @keydown.enter.prevent="togglePoint(point.from)" @keydown.space.prevent="togglePoint(point.from)"
              @keydown.left.prevent="movePoint(i,-1,$event)" @keydown.right.prevent="movePoint(i,1,$event)"
              @keydown.home.prevent="movePoint(i,-i,$event)" @keydown.end.prevent="movePoint(i,data.series.length-i-1,$event)">
              <title>{{pointLabel(point)}}</title>
              <rect data-trend-highlight v-if="activePoint?.from===point.from" :x="i*600/data.series.length" :y="observedPeak===0?130:10" :width="600/data.series.length" :height="observedPeak===0?0:120" fill="currentColor" class="text-muted" rx="2" />
              <rect v-if="point.metrics.totalTokens.value!==null && point.metrics.totalTokens.value>0" :x="i*600/data.series.length+2" :y="130-Number(point.metrics.totalTokens.value)/peak*120" :width="Math.max(1,600/data.series.length-4)" :height="Number(point.metrics.totalTokens.value)/peak*120" fill="currentColor" rx="2" />
              <line v-else :x1="i*600/data.series.length+2" :x2="(i+1)*600/data.series.length-2" y1="130" y2="130" stroke="currentColor" :stroke-dasharray="point.metrics.totalTokens.value===null?'2 3':undefined" />
              <rect :x="i*600/data.series.length" y="10" :width="600/data.series.length" height="120" fill="transparent" />
            </g>
            <line v-if="observedPeak!==null" x1="0" x2="600" :y1="observedPeak>0?10:130" :y2="observedPeak>0?10:130" stroke="currentColor" stroke-dasharray="4 4" class="pointer-events-none text-muted-foreground" />
            <line x1="0" x2="600" y1="130" y2="130" stroke="currentColor" class="pointer-events-none text-muted-foreground" />
          </svg>
          <div class="flex justify-between text-xs text-muted-foreground"><span>{{time(data.series[0]!.from)}}</span><span>{{time(data.series.at(-1)!.to)}}</span></div>
        </CardContent></Card>
        <Card size="compact" class="min-w-0"><CardHeader><CardTitle>团队消耗</CardTitle></CardHeader><CardContent class="flex max-h-80 min-w-0 flex-col gap-3 overflow-y-auto"><p v-if="!ranks.length" class="text-sm text-muted-foreground">暂无团队</p><Button v-for="team in ranks" :key="team.id" variant="ghost" class="h-auto min-w-0 justify-start px-0" @click="emit('select',team.id)"><span class="flex w-full min-w-0 flex-col gap-2"><span class="flex min-w-0 justify-between gap-3"><span class="truncate">{{team.name}}</span><span class="shrink-0 tabular-nums">{{number(team.metrics.totalTokens.value)}}<span v-if="team.expectedTurns>team.tokenBatches || (team.metrics.totalTokens.value!==null && team.metrics.totalTokens.completeness!=='complete')" class="text-xs text-muted-foreground"> · 部分</span></span></span><Progress v-if="team.metrics.totalTokens.value!==null" :model-value="Number(team.metrics.totalTokens.value)/max*100" :aria-label="`${team.name}：${team.metrics.totalTokens.value} token`" class="h-2" /><span v-else class="text-left text-xs text-muted-foreground">暂无 Token 观测</span></span></Button></CardContent></Card>
      </div>
      <Card size="compact"><CardHeader><CardTitle>团队状态 · 当前快照</CardTitle><span class="text-xs text-muted-foreground">{{new Date(data.generatedAt).toLocaleTimeString()}}</span></CardHeader><CardContent class="flex flex-col gap-4"><div class="grid gap-3 sm:grid-cols-3"><div v-for="state in data.states" :key="state.state" class="flex items-center gap-3"><span class="w-24 shrink-0 text-xs">{{labels[state.state]}}</span><Progress :model-value="state.count/Math.max(1,data.counts.teams)*100" :aria-label="`${labels[state.state]} ${state.count} 个团队`" class="h-2" /><span class="tabular-nums">{{state.count}}</span></div></div><Disclosure><template #summary>输入、输出与缓存</template><dl class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><div v-for="key in (['inputTokensTotal','outputTokens','cacheReadTokens','cacheReadRatio'] as const)" :key="key"><dt>{{ {inputTokensTotal:'输入',outputTokens:'输出',cacheReadTokens:'缓存读取（输入的子集）',cacheReadRatio:'缓存读取占输入'}[key] }}</dt><dd>{{key==='cacheReadRatio'&&data.totals[key].value!==null?`${(Number(data.totals[key].value)*100).toFixed(1)}%`:number(data.totals[key].value)}}</dd></div></dl></Disclosure></CardContent></Card>
    </template>
      </div>
</Disclosure>
  </section>
</template>
