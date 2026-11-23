import type { InjectionKey } from 'vue';

export interface FilePreviewContext {
  open: (path: string) => void;
}

export const filePreviewContext: InjectionKey<FilePreviewContext> = Symbol('message-file-preview');

const SUPPORTED_EXT = /\.(?:md|markdown|txt|json|mjs|js|cjs|ts|mts|tsx|jsx|vue|css|scss|yml|yaml|toml|sql|sh|html|xml|csv|diff|patch)(?:#L?\d+(?:-L?\d+)?)?$/i;

function normalizeCandidate(raw: string): string | null {
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, '').replace(/[),.;:!?]+$/, '');
  if (!cleaned || cleaned.includes('\0') || cleaned.length > 260) return null;
  if (/^(?:https?|mailto|file|data|javascript):/i.test(cleaned)) return null;
  if (cleaned.startsWith('#') || cleaned.includes('..')) return null;
  if (!SUPPORTED_EXT.test(cleaned)) return null;
  return cleaned;
}

/**
 * 从消息正文提取工作区文档/源码路径引用（纯只读前端辅助）：
 * - 优先提取 Markdown 链接 `[...](path)` 与行内代码 `` `path` ``；
 * - 再匹配明显的路径字面量（含 `/` 的 docs/...、src/... 等）；
 * - 去重、过滤 URL 与 `..`，每条消息最多展示 4 枚筹码防止刷屏。
 */
export function extractFilePathRefs(text: string, limit = 4): string[] {
  if (!text) return [];
  const results: string[] = [];
  const push = (raw: string) => {
    const candidate = normalizeCandidate(raw);
    if (!candidate || results.includes(candidate)) return;
    results.push(candidate);
  };

  for (const match of text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
    if (results.length >= limit) break;
    if (match[1]) push(match[1]);
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    if (results.length >= limit) break;
    if (match[1] && !/\s/.test(match[1].trim())) push(match[1]);
  }
  for (const match of text.matchAll(/(?:^|[\s(（【])((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.(?:md|markdown|txt|json|mjs|js|ts|tsx|vue|yml|yaml)(?:#L?\d+(?:-L?\d+)?)?)/g)) {
    if (results.length >= limit) break;
    if (match[1]) push(match[1]);
  }
  return results.slice(0, limit);
}

export function fileRefBasename(filePath: string): string {
  const clean = filePath.replace(/#L?\d+(?:-L?\d+)?$/i, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? filePath;
}
