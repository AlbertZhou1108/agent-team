<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Send } from '@lucide/vue';
import { identityColor, identityTintBg, identityTintFg } from '@/features/messages/identity';
import {
  buildCompactArcPath,
  buildExpandedCurvePath,
  type TopologyEdge,
  type TopologyFlight,
  type TopologyMember,
} from '@/features/messages/topology';
import { MOTION_EASING, motionDurationMs, prefersReducedMotion } from '@/shared/motion';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { runPhaseLabel } from '@/features/messages/run-rows';

const props = withDefaults(
  defineProps<{
    mode: 'compact' | 'expanded';
    members: TopologyMember[];
    edges: TopologyEdge[];
    flights: TopologyFlight[];
    hoveredMember?: string | null;
    anchorElements?: Record<string, HTMLElement | null>;
  }>(),
  {
    hoveredMember: null,
    anchorElements: () => ({}),
  },
);

const emit = defineEmits<{
  hoverMember: [name: string | null];
  flightDone: [id: string];
}>();

const rootRef = ref<HTMLElement | null>(null);
const compactAvatarRefs = ref<Record<string, HTMLElement | null>>({});
const containerSize = ref({ width: 0, height: 0 });
const anchors = ref<Record<string, { x: number; y: number }>>({});

function setCompactAvatarRef(name: string, el: unknown) {
  if (el instanceof HTMLElement) {
    compactAvatarRefs.value[name] = el;
  } else {
    delete compactAvatarRefs.value[name];
  }
}

function measureAnchors() {
  const root = rootRef.value;
  if (!root) return;
  const rootRect = root.getBoundingClientRect();
  const sx = root.offsetWidth > 0 && rootRect.width > 0 ? rootRect.width / root.offsetWidth : 1;
  const sy = root.offsetHeight > 0 && rootRect.height > 0 ? rootRect.height / root.offsetHeight : 1;
  containerSize.value = {
    width: root.offsetWidth || rootRect.width,
    height: root.offsetHeight || rootRect.height,
  };

  const next: Record<string, { x: number; y: number }> = {};
  if (props.mode === 'compact') {
    for (const member of props.members) {
      const el = compactAvatarRefs.value[member.name];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      next[member.name] = {
        x: Math.round(((rect.left - rootRect.left + rect.width / 2) / sx) * 10) / 10,
        y: Math.round(((rect.top - rootRect.top) / sy) * 10) / 10,
      };
    }
  } else {
    for (const member of props.members) {
      const el = props.anchorElements[member.name];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      next[member.name] = {
        x: Math.max(0, Math.round(((rect.right - rootRect.left) / sx) * 10) / 10),
        y: Math.round(((rect.top - rootRect.top + rect.height / 2) / sy) * 10) / 10,
      };
    }
  }
  anchors.value = next;
}

let resizeObserver: ResizeObserver | null = null;
let rafId = 0;

function scheduleMeasure() {
  if (typeof requestAnimationFrame === 'undefined') return;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    measureAnchors();
  });
}

onMounted(() => {
  scheduleMeasure();
  if (typeof ResizeObserver !== 'undefined' && rootRef.value) {
    resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(rootRef.value);
  }
});

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId);
  resizeObserver?.disconnect();
});

watch(
  () => [props.mode, props.members, props.anchorElements],
  () => void nextTick(scheduleMeasure),
  { deep: true },
);

const memberIndexMap = computed(() => {
  const map = new Map<string, number>();
  props.members.forEach((m, idx) => map.set(m.name, idx));
  return map;
});

type RenderedEdge = TopologyEdge & {
  path: string;
  dimmed: boolean;
  highlighted: boolean;
};

const renderedEdges = computed<RenderedEdge[]>(() => {
  const out: RenderedEdge[] = [];
  const maxBulge = Math.max(64, (containerSize.value.width || 160) - 24);

  for (const edge of props.edges) {
    const p1 = anchors.value[edge.from];
    const p2 = anchors.value[edge.to];
    if (!p1 || !p2) continue;

    const i1 = memberIndexMap.value.get(edge.from) ?? 0;
    const i2 = memberIndexMap.value.get(edge.to) ?? 0;
    const span = Math.abs(i1 - i2);
    const path = props.mode === 'compact'
      ? buildCompactArcPath(p1.x, p1.y, p2.x, p2.y, span)
      : buildExpandedCurvePath(p1.x, p1.y, p2.x, p2.y, span, maxBulge);

    const hovered = props.hoveredMember;
    const related = !hovered || edge.from === hovered || edge.to === hovered;
    out.push({
      ...edge,
      path,
      dimmed: Boolean(hovered && !related),
      highlighted: Boolean(hovered && related),
    });
  }
  return out;
});

const activeFlightPaths = computed(() => {
  const result: Array<TopologyFlight & { path: string }> = [];
  const maxBulge = Math.max(64, (containerSize.value.width || 160) - 24);
  for (const flight of props.flights) {
    const p1 = anchors.value[flight.from];
    const p2 = anchors.value[flight.to];
    if (!p1 || !p2) continue;
    const i1 = memberIndexMap.value.get(flight.from) ?? 0;
    const i2 = memberIndexMap.value.get(flight.to) ?? 0;
    const span = Math.abs(i1 - i2);
    const path = props.mode === 'compact'
      ? buildCompactArcPath(p1.x, p1.y, p2.x, p2.y, span)
      : buildExpandedCurvePath(p1.x, p1.y, p2.x, p2.y, span, maxBulge);
    result.push({ ...flight, path });
  }
  return result;
});

const hasActiveLinks = computed(
  () => renderedEdges.value.length > 0 || activeFlightPaths.value.length > 0,
);

const activeAnchorPoints = computed(() => {
  const connected = new Set<string>();
  for (const edge of renderedEdges.value) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const out: Record<string, { x: number; y: number }> = {};
  for (const name of connected) {
    const pt = anchors.value[name];
    if (pt) out[name] = pt;
  }
  return out;
});

const animatingIds = new Set<string>();

function bindPlaneRef(flightId: string, path: string, el: unknown) {
  if (!(el instanceof HTMLElement) || animatingIds.has(flightId)) return;
  animatingIds.add(flightId);

  if (prefersReducedMotion() || typeof el.animate !== 'function') {
    const timer = setTimeout(() => {
      animatingIds.delete(flightId);
      emit('flightDone', flightId);
    }, 600);
    el.dataset.reducedTimer = String(timer);
    return;
  }

  const anim = el.animate(
    [
      { offsetDistance: '0%', opacity: 0.85 },
      { offsetDistance: '100%', opacity: 1 },
    ],
    {
      duration: motionDurationMs('slow'),
      easing: MOTION_EASING.out,
      fill: 'forwards',
    },
  );
  anim.onfinish = () => {
    animatingIds.delete(flightId);
    emit('flightDone', flightId);
  };
  anim.oncancel = () => {
    animatingIds.delete(flightId);
  };
  void path;
}

function isMemberDimmed(name: string) {
  if (!props.hoveredMember || props.hoveredMember === name) return false;
  return !props.edges.some(
    edge =>
      (edge.from === props.hoveredMember && edge.to === name)
      || (edge.to === props.hoveredMember && edge.from === name),
  );
}
</script>

<template>
  <div
    ref="rootRef"
    class="topology-overlay"
    :class="[
      mode === 'compact' ? 'topology-compact' : 'topology-expanded',
      mode === 'compact' && hasActiveLinks && 'topology-compact-with-arcs',
    ]"
    data-testid="member-topology-overlay"
  >
    <svg
      v-if="renderedEdges.length"
      class="topology-svg"
      aria-hidden="true"
    >
      <path
        v-for="edge in renderedEdges"
        :key="edge.id"
        :d="edge.path"
        fill="none"
        class="topology-edge"
        :class="{
          'topology-edge-active': edge.active || edge.highlighted,
          'topology-edge-dimmed': edge.dimmed,
        }"
        :style="
          edge.active || edge.highlighted
            ? { stroke: identityColor(edge.from) }
            : undefined
        "
        :stroke-dasharray="mode === 'compact' ? '3 3' : '4 4'"
      />
      <circle
        v-for="(pt, name) in activeAnchorPoints"
        :key="name"
        :cx="pt.x"
        :cy="pt.y"
        :r="mode === 'compact' ? 2 : 3"
        class="topology-anchor-dot"
        :style="{ fill: identityColor(String(name)) }"
      />
    </svg>

    <div class="topology-planes" aria-hidden="true">
      <span
        v-for="flight in activeFlightPaths"
        :key="flight.id"
        :ref="el => bindPlaneRef(flight.id, flight.path, el)"
        class="topology-plane"
        :class="mode === 'compact' ? 'topology-plane-compact' : 'topology-plane-expanded'"
        :style="{
          offsetPath: `path('${flight.path}')`,
          color: identityColor(flight.colorKey),
        }"
      >
        <Send :class="mode === 'compact' ? 'size-2.5' : 'size-3.5'" />
      </span>
    </div>

    <TooltipProvider v-if="mode === 'compact'" :delay-duration="250">
      <div class="topology-compact-avatars">
        <Tooltip v-for="member in members" :key="member.name">
          <TooltipTrigger as-child>
            <span
              :ref="el => setCompactAvatarRef(member.name, el)"
              class="topology-avatar"
              :class="{ 'topology-avatar-dimmed': isMemberDimmed(member.name) }"
              :style="{
                backgroundColor: identityTintBg(member.name),
                color: identityTintFg(member.name),
              }"
              @mouseenter="emit('hoverMember', member.name)"
              @mouseleave="emit('hoverMember', null)"
            >
              {{ member.name.slice(0, 1) }}
              <span
                class="topology-avatar-status"
                :class="member.active ? 'topology-avatar-status-active' : 'topology-avatar-status-idle'"
                aria-hidden="true"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" class="text-xs">
            {{ member.name }}{{ member.phase ? ` · ${runPhaseLabel(member.phase)}` : '' }}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  </div>
</template>
