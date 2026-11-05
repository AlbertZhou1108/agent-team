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

/** 少于三根刻度不值得出现：没人需要为两三段内容再开一条导航。 */
export const MIN_SEGMENTS = 3;

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

/** 顶部已越过视口顶的最后一条刻度就是当前段；还没滚动时取第一段。 */
export function resolveCurrentSegment(anchors: OutlineAnchor[], viewportTop = 0): string | null {
  let current: string | null = null;
  for (const anchor of anchors) {
    if (anchor.top > viewportTop + 1) break;
    current = anchor.id;
  }
  return current ?? anchors[0]?.id ?? null;
}
