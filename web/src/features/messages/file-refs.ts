import type { InjectionKey } from 'vue';

export interface FilePreviewContext {
  open: (path: string) => void;
}

export const filePreviewContext: InjectionKey<FilePreviewContext> = Symbol('message-file-preview');

export type TextFileSegment =
  | { type: 'text'; text: string }
  | { type: 'file'; label: string; path: string };

const EXT_PATTERN = String.raw`(?:md|markdown|txt|json|mjs|js|cjs|ts|mts|tsx|jsx|vue|css|scss|yml|yaml|toml|sql|sh|html|xml|csv|diff|patch)(?:#L?\d+(?:-L?\d+)?)?`;
const SUPPORTED_EXT = new RegExp(`\\.${EXT_PATTERN}$`, 'i');
const BARE_PATH_RE = new RegExp(
  `(^|[\\s(（【])((?:[A-Za-z0-9._-]+\\/)+[A-Za-z0-9._-]+\\.${EXT_PATTERN})(?=$|[\\s)）】.,;!?，。；！？])`,
  'gi',
);
const INLINE_REF_RE = new RegExp(
  `\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)|\`([^\`\\n]+)\`|(^|[\\s(（【])((?:[A-Za-z0-9._-]+\\/)+[A-Za-z0-9._-]+\\.${EXT_PATTERN})(?=$|[\\s)）】.,;!?，。；！？])`,
  'gim',
);

/**
 * 校验并规范化消息正文中的本地文件路径引用（过滤 URL、锚点与 `..` 越界）。
 */
export function normalizeFilePathRef(raw: string): string | null {
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, '').replace(/[),.;:!?]+$/, '');
  if (!cleaned || cleaned.includes('\0') || cleaned.length > 260) return null;
  if (/^(?:https?|mailto|file|data|javascript):/i.test(cleaned)) return null;
  if (cleaned.startsWith('#') || cleaned.includes('..')) return null;
  if (!SUPPORTED_EXT.test(cleaned)) return null;
  return cleaned;
}

export function fileRefBasename(filePath: string): string {
  const clean = filePath.replace(/#L?\d+(?:-L?\d+)?$/i, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? filePath;
}

/** 决定内联文件筹码的展示文案：链接文本与路径/文件名一致时仅显示文件名，否则保留链接原语义。 */
export function fileRefDisplayLabel(rawLabel: string, filePath: string): string {
  const trimmed = rawLabel.trim();
  const base = fileRefBasename(filePath);
  if (!trimmed || trimmed === filePath || trimmed === base) return base;
  return trimmed;
}

/** 将 Markdown 普通文本段中显式的 `dir/file.ext` 路径拆分为文本与文件引用片段。 */
export function splitBareFileRefs(text: string): TextFileSegment[] {
  if (!text) return [];
  const segments: TextFileSegment[] = [];
  let cursor = 0;
  BARE_PATH_RE.lastIndex = 0;
  for (const match of text.matchAll(BARE_PATH_RE)) {
    const index = match.index ?? 0;
    const prefix = match[1] ?? '';
    const rawPath = match[2] ?? '';
    const candidate = normalizeFilePathRef(rawPath);
    if (!candidate) continue;
    const pathStart = index + prefix.length;
    if (pathStart > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, pathStart) });
    }
    segments.push({ type: 'file', label: fileRefBasename(candidate), path: candidate });
    cursor = pathStart + rawPath.length;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) });
  }
  return segments.length ? segments : [{ type: 'text', text }];
}

/** 将纯文本消息（如用户指令）中的 `[label](path)`、`` `path` `` 与 `dir/file.ext` 原地拆分为可交互筹码片段。 */
export function splitPlainTextFileRefs(text: string): TextFileSegment[] {
  if (!text) return [];
  const segments: TextFileSegment[] = [];
  let cursor = 0;
  INLINE_REF_RE.lastIndex = 0;
  for (const match of text.matchAll(INLINE_REF_RE)) {
    const index = match.index ?? 0;
    if (match[1] !== undefined && match[2] !== undefined) {
      const candidate = normalizeFilePathRef(match[2]);
      if (!candidate) continue;
      if (index > cursor) segments.push({ type: 'text', text: text.slice(cursor, index) });
      segments.push({ type: 'file', label: fileRefDisplayLabel(match[1], candidate), path: candidate });
      cursor = index + match[0].length;
    } else if (match[3] !== undefined) {
      const rawCode = match[3];
      if (/\s/.test(rawCode.trim())) continue;
      const candidate = normalizeFilePathRef(rawCode);
      if (!candidate) continue;
      if (index > cursor) segments.push({ type: 'text', text: text.slice(cursor, index) });
      segments.push({ type: 'file', label: fileRefBasename(candidate), path: candidate });
      cursor = index + match[0].length;
    } else if (match[5] !== undefined) {
      const prefix = match[4] ?? '';
      const rawPath = match[5];
      const candidate = normalizeFilePathRef(rawPath);
      if (!candidate) continue;
      const pathStart = index + prefix.length;
      if (pathStart > cursor) segments.push({ type: 'text', text: text.slice(cursor, pathStart) });
      segments.push({ type: 'file', label: fileRefBasename(candidate), path: candidate });
      cursor = pathStart + rawPath.length;
    }
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) });
  }
  return segments.length ? segments : [{ type: 'text', text }];
}
