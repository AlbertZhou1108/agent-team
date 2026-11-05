import type { MessageView } from '@/shared/models/view-types';

/** 会话大纲的一根刻度：用户的一次意图。 */
export interface OutlineSegment {
  /** 刻度消息 id，同时是滚动锚点。 */
  id: string;
  index: number;
  title: string;
}

export interface OutlineAnchor {
  id: string;
  /** 相对滚动区顶部的偏移（负数 = 已滚出顶部）。 */
  top: number;
}

/**
 * 轨道上真正绘制的一块：覆盖一段或几段（并组后），每块等高。
 * 起止点是 0..1 的比例，由调用方乘上轨道实高——比例而不是像素，
 * 是为了让布局与轨道高度解耦，窗口缩放时不必重算。
 */
export interface OutlineBand {
  /** 这一块覆盖的原始段序号（升序）；并组后可能多于一个。 */
  indexes: number[];
  /** 首段：跳转锚点与悬停标题都用它。 */
  id: string;
  title: string;
  start: number;
  end: number;
}

/** 少于三根刻度不值得出现：没人需要为两三段内容再开一条导航。 */
export const MIN_SEGMENTS = 3;

/**
 * 轨道上一格的高度：一条细线加上下呼吸，同时是最小可点目标。
 * 整条轨的高度永远是它的整数倍。
 */
export const OUTLINE_BAND_PITCH = 8;

/**
 * 轨道的最大高度。这是粒度的锚：段数一旦超过「最大高度 ÷ 格高」，
 * 就把相邻段并组放粗粒度，轨道本身不再长高。
 */
export const OUTLINE_MAX_HEIGHT = 320;

/** 容量：轨道最多呈现多少块，由上面两个数推出，不单独配置。 */
export const OUTLINE_MAX_BANDS = Math.floor(OUTLINE_MAX_HEIGHT / OUTLINE_BAND_PITCH);

const TITLE_LIMIT = 24;

function segmentTitle(message: MessageView, index: number): string {
  const line = message.text.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  const title = line.replace(/\s+/g, ' ').slice(0, TITLE_LIMIT);
  return title || `第 ${index + 1} 段`;
}

/**
 * 刻度 = 用户消息。一条用户消息就是一次意图，它之后的内部往返都属于这一段，
 * 直到下一条用户消息。没有用户消息的会话（纯 Agent 跑批）没有章节，返回空。
 */
export function buildOutlineSegments(messages: MessageView[]): OutlineSegment[] {
  const ticks = messages.filter(message => message.senderIsUser);
  if (ticks.length < MIN_SEGMENTS) return [];
  return ticks.map((message, index) => ({
    id: message.id,
    index,
    title: segmentTitle(message, index),
  }));
}

/**
 * 把段列表排到轨道上，**每块等高**。
 *
 * 为什么等高而不是按段落长短分配：这块轨道的职责是「跳到第几次提问」，
 * 是可点目标，不是长度地图。按篇幅分配会让长段落占一条粗带、短段落变成
 * 1–2px 的细线——细线既看不清也点不准，等于同一条轨道上存在两种可点精度。
 * 等高之后每一块的准头一致，读者不需要先判断"这条细的能不能点"。
 *
 * 粒度由轨道容量决定（容量 = OUTLINE_MAX_HEIGHT ÷ OUTLINE_BAND_PITCH）：
 * - 段数在容量之内：一段一块，轨道按段数缩短，抱住内容。
 * - 段数超出容量：块数封顶在容量，段按顺序尽量均分到各块（余数摊到前面，
 *   各块段数最多差一段）——等高轨道上每块的"密度"因此是均匀的，
 *   不会出现某一块代表 2 段、旁边一块代表 20 段的突兀落差。
 */
export function layoutOutlineBands(
  segments: OutlineSegment[],
  { maxBands = Infinity }: { maxBands?: number } = {},
): OutlineBand[] {
  if (!segments.length) return [];

  const capacity = Math.max(1, Math.floor(maxBands));
  const count = Math.min(segments.length, capacity);
  const base = Math.floor(segments.length / count);
  // 余数摊到前面若干块上：各块段数最多差一段，粒度看起来是均匀的。
  const extra = segments.length % count;

  const chunks: OutlineSegment[][] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < extra ? 1 : 0);
    chunks.push(segments.slice(cursor, cursor + size));
    cursor += size;
  }

  return chunks.map((chunk, index) => ({
    indexes: chunk.map(segment => segment.index),
    // 合并块的锚点与标题取组内第一段：跳转落在这一组的开头。
    id: chunk[0]!.id,
    title: chunk[0]!.title,
    start: index / count,
    end: (index + 1) / count,
  }));
}

/** 顶部已越过视口顶的最后一条刻度就是当前段；还没滚动时取第一段。 */
export function resolveCurrentSegment(anchors: OutlineAnchor[], viewportTop = 0): string | null {
  let current: string | null = null;
  for (const anchor of anchors) {
    if (anchor.top > viewportTop + 1) break;
    current = anchor.id;
  }
  return current ?? anchors[0]?.id ?? null;
}
