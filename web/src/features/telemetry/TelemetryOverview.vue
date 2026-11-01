<script setup lang="ts">
import TelemetryDistribution from './TelemetryDistribution.vue';
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
type Team = { id:string;name:string;status:string;batchCount:number;metrics:TelemetryMetrics;expectedTurns:number;tokenBatches:number };
type Distribution = {id:string;name:string;batchCount:number;metrics:TelemetryMetrics};
type Overview = { hosts:Distribution[];models:Distribution[];batchCount:number; generatedAt:string;counts:{teams:number;members:number;running:number};totals:TelemetryMetrics;coverage:{expectedTurns:number;tokenBatches:number;missingTurns:number};teams:Team[];series:{from:string;to:string;batchCount:number;metrics:TelemetryMetrics}[];states:{state:string;count:number}[];scope:string;timeBasis:string };
const emit=defineEmits<{select:[id:string]}>();
const days=ref(1);
const filters=ref<Record<string,string>>({});
const filterNames=ref<Record<string,string>>({});
function filter(key:string,id:string,name:string){
  const next={...filters.value};
  if(next[key]===id){delete next[key];delete filterNames.value[key];}
  else {next[key]=id;filterNames.value[key]=name;}
  filters.value=next;
}
function clearFilters(){filters.value={};filterNames.value={};}
const composition=computed(()=>{
  const totals=data.value?.totals;
  if(!totals)return [];
  return ([['uncachedInputTokens','普通输入'],['cacheReadTokens','缓存读取'],['cacheWriteTokens','缓存写入'],['outputTokens','输出']] as const)
    .map(([key,label])=>({key,label,value:totals[key].value}));
});
const compositionColors=['var(--primary)','var(--info)','var(--warning)','var(--success)'];
const compositionTotal=computed(()=>composition.value.reduce((sum,item)=>sum+(item.value??0),0));
const overviewOpen=ref(false);
function selectedRange(){const now=new Date();const start=new Date(now);start.setHours(0,0,0,0);start.setDate(start.getDate()-(days.value-1));return{from:start.toISOString(),to:now.toISOString(),bucket:days.value===1?'hour':'day'}}
const query=useQuery({queryKey:computed(()=>['telemetry-overview',days.value,filters.value]),queryFn:async({signal})=>{const response=await fetch('/api/telemetry/overview?'+new URLSearchParams({...selectedRange(),...filters.value}),{signal});if(!response.ok)throw Error(await response.text());return response.json() as Promise<Overview>},refetchInterval:15000,refetchOnWindowFocus:false});
const data=computed(()=>query.data.value);
const seriesRows=computed(()=>data.value?.series??[]);
const selectedFrom = ref<string | null>(null);
const hoveredFrom = ref<string | null>(null);
watch([days,filters], () => { selectedFrom.value = null; hoveredFrom.value = null; });
const overviewActive = computed(() => hoveredFrom.value === null && selectedFrom.value === null);
const overviewTotals = computed(() => {
  const series = seriesRows.value;
  if (!series.length) return null;
  const values = series.map(point => point.metrics.totalTokens.value).filter((value): value is number => typeof value === 'number');
  return {
    from: series[0]!.from,
    to: series.at(-1)!.to,
    sum: values.reduce((sum, value) => sum + value, 0),
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
  return `${period(point)}，${metric.value === null ? '暂无 Token 数据' : `${Number(metric.value).toLocaleString()} Token`}，${point.batchCount} 个回合`;
}
function movePoint(index: number, step: number, event: KeyboardEvent) {
  const series = seriesRows.value;
  const next = Math.max(0, Math.min(series.length - 1, index + step));
  if (!series[next]) return;
  selectedFrom.value = series[next].from;
  const items = (event.currentTarget as Element).parentElement?.querySelectorAll<SVGElement>('[data-trend-bucket]');
  items?.[next]?.focus();
}

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
      <div v-if="Object.keys(filters).length" class="flex flex-wrap items-center gap-2">
        <Button v-for="(name,key) in filterNames" :key="key" variant="secondary" size="sm" @click="filter(String(key),filters[key]!,name)">{{name}} ×</Button>
        <Button variant="outline" size="sm" @click="clearFilters">清除筛选</Button>
        <Button v-if="filters.team" variant="ghost" size="sm" @click="emit('select',filters.team)">打开团队</Button>
      </div>
      <dl class="grid grid-cols-2 gap-4 sm:grid-cols-4"><div v-for="item in [{label:'团队',value:data.counts.teams},{label:'成员',value:data.counts.members},{label:'运行中回合',value:data.counts.running},{label:'Token',value:data.totals.totalTokens.value}]" :key="item.label" class="flex flex-col gap-1"><dt class="text-xs text-muted-foreground">{{item.label}}</dt><dd class="text-2xl font-semibold tabular-nums">{{number(item.value)}}</dd></div></dl>
      <div class="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card size="compact" class="min-w-0"><CardHeader><CardTitle>消耗趋势</CardTitle></CardHeader><CardContent class="flex min-w-0 flex-col gap-3">
          <div v-if="overviewActive && overviewTotals" class="flex flex-wrap items-start justify-between gap-3" aria-live="polite" aria-atomic="true" data-testid="trend-selection">
            <div class="flex flex-col gap-1"><span class="text-xs text-muted-foreground">{{time(overviewTotals.from)}} – {{time(overviewTotals.to)}} · 整个时间轴</span><span class="font-medium tabular-nums">{{overviewTotals.observed?`${overviewTotals.sum.toLocaleString()} Token`:'暂无 Token 数据'}}</span><span class="text-xs text-muted-foreground">共 {{overviewTotals.batches}} 个回合；点击柱形可查看单时段</span></div>
          </div>
          <div v-else-if="activePoint" class="flex flex-wrap items-start justify-between gap-3" aria-live="polite" aria-atomic="true" data-testid="trend-selection">
            <div class="flex flex-col gap-1"><span class="text-xs text-muted-foreground">{{period(activePoint)}}</span><span class="font-medium tabular-nums">{{activePoint.metrics.totalTokens.value===null?'暂无 Token 数据':`${Number(activePoint.metrics.totalTokens.value).toLocaleString()} Token`}}</span><span class="text-xs text-muted-foreground">再次点击该柱形可返回整轴统计</span></div>
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
        <TelemetryDistribution title="团队消耗" :rows="data.teams" :selected="filters.team" @select="id=>filter('team',id,data!.teams.find(t=>t.id===id)!.name)" />
        <TelemetryDistribution title="宿主分布" :rows="data.hosts ?? []" :selected="filters.host" @select="id=>filter('host',id,data!.hosts.find(t=>t.id===id)!.name)" />
        <TelemetryDistribution title="模型排行" :rows="data.models ?? []" :selected="filters.model" @select="id=>filter('model',id,data!.models.find(t=>t.id===id)!.name)" />
      </div>
      <Card size="compact"><CardHeader><CardTitle>消耗构成</CardTitle></CardHeader><CardContent class="flex flex-col gap-4">
        <div class="flex h-5 overflow-hidden rounded-md" role="img" aria-label="Token 消耗构成">
          <div v-for="(item,i) in composition" :key="item.key" :style="{width:`${compositionTotal ? (item.value??0)/compositionTotal*100 : 0}%`,background:compositionColors[i]}" :title="`${item.label}：${number(item.value)}`" />
        </div>
        <dl class="grid grid-cols-2 gap-4 sm:grid-cols-4"><div v-for="(item,i) in composition" :key="item.key" class="flex flex-col gap-1"><dt class="flex items-center gap-2 text-sm text-muted-foreground"><span class="size-2 rounded-full" :style="{background:compositionColors[i]}" />{{item.label}}</dt><dd class="tabular-nums">{{number(item.value)}} <span v-if="item.value!==null && compositionTotal" class="text-xs text-muted-foreground">{{(item.value/compositionTotal*100).toFixed(1)}}%</span></dd></div></dl>
      </CardContent></Card>
      <Card size="compact"><CardHeader><CardTitle>团队状态 · 当前快照</CardTitle><span class="text-xs text-muted-foreground">{{new Date(data.generatedAt).toLocaleTimeString()}}</span></CardHeader><CardContent class="flex flex-col gap-4"><div class="grid gap-3 sm:grid-cols-3"><div v-for="state in data.states" :key="state.state" class="flex items-center gap-3"><span class="w-24 shrink-0 text-xs">{{labels[state.state]}}</span><Progress :model-value="state.count/Math.max(1,data.counts.teams)*100" :aria-label="`${labels[state.state]} ${state.count} 个团队`" class="h-2" /><span class="tabular-nums">{{state.count}}</span></div></div></CardContent></Card>
    </template>
      </div>
</Disclosure>
  </section>
</template>
