/**
 * 团队工作区只读文本/Markdown 预览（专项 3）：
 * - 严格 realpath 校验：文件必须真实落在当前团队 workspace 或有效成员 worktree 内，
 *   阻断 ../ 路径穿越与指向外部的符号链接；
 * - 扩展名白名单 + NUL 二进制拒绝 + 128 KB 读取上限，不向前端暴露任意本机文件。
 */
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';

export const MAX_FILE_PREVIEW_BYTES = 128 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.mjs', '.js', '.cjs',
  '.ts', '.mts', '.tsx', '.jsx', '.vue', '.css', '.scss',
  '.yml', '.yaml', '.toml', '.sql', '.sh', '.html', '.xml', '.csv',
  '.diff', '.patch',
]);
const ALLOWED_EXACT_NAMES = new Set(['README', 'LICENSE', 'Dockerfile', 'Makefile', '.gitignore', '.gitattributes']);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function isInsideRoot(rootReal, targetReal) {
  const rel = relative(rootReal, targetReal);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function assertAllowedFilename(filePath) {
  const ext = extname(filePath).toLowerCase();
  const base = basename(filePath);
  if (ALLOWED_EXTENSIONS.has(ext) || ALLOWED_EXACT_NAMES.has(base)) return;
  throw httpError(400, '仅支持预览 Markdown 与常见文本/代码文件');
}

function allowedRootsForGroup(group, members = [], memberId = null) {
  const roots = [];
  const pushRoot = (kind, rawPath, ownerMember = null) => {
    if (!rawPath || typeof rawPath !== 'string' || !existsSync(rawPath)) return;
    try {
      const real = realpathSync(resolve(rawPath));
      if (!statSync(real).isDirectory()) return;
      if (!roots.some(item => item.real === real)) {
        roots.push({ kind, real, memberId: ownerMember?.id ?? null, memberName: ownerMember?.name ?? null });
      }
    } catch { /* ignore broken root */ }
  };
  const pinned = memberId ? members.find(member => member.id === memberId) : null;
  if (pinned?.workspace_mode === 'worktree' && pinned.worktree_path) {
    pushRoot('worktree', pinned.worktree_path, pinned);
  }
  pushRoot('workspace', group.workspace);
  if (!pinned) {
    for (const member of members) {
      if (member.workspace_mode === 'worktree' && member.worktree_path) {
        pushRoot('worktree', member.worktree_path, member);
      }
    }
  }
  return roots;
}

export function previewGroupTextFile({ group, members = [], filePath, memberId = null }) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    throw httpError(400, '文件路径无效');
  }
  const normalizedInput = filePath.trim().replace(/#L?\d+(?:-L?\d+)?$/i, '');
  if (/^(?:https?|file|data|javascript):/i.test(normalizedInput)) {
    throw httpError(400, '仅支持预览团队本地工作区文件');
  }
  assertAllowedFilename(normalizedInput);

  const roots = allowedRootsForGroup(group, members, memberId);
  if (!roots.length) throw httpError(404, '团队工作目录不存在');

  let matched = null;
  if (isAbsolute(normalizedInput)) {
    const resolvedInput = resolve(normalizedInput);
    if (!existsSync(resolvedInput)) throw httpError(404, '文件不存在');
    const targetReal = realpathSync(resolvedInput);
    const ownerRoot = roots.find(root => isInsideRoot(root.real, targetReal));
    if (!ownerRoot) throw httpError(403, '文件路径超出团队工作区边界');
    matched = { targetReal, root: ownerRoot };
  } else {
    let sawLexicalEscape = false;
    let sawSymlinkEscape = false;
    for (const root of roots) {
      const candidate = resolve(root.real, normalizedInput);
      const lexicalRel = relative(root.real, candidate);
      if (!lexicalRel || lexicalRel.startsWith('..') || isAbsolute(lexicalRel)) {
        sawLexicalEscape = true;
        continue;
      }
      if (!existsSync(candidate)) continue;
      const targetReal = realpathSync(candidate);
      if (!isInsideRoot(root.real, targetReal)) {
        sawSymlinkEscape = true;
        continue;
      }
      matched = { targetReal, root };
      break;
    }
    if (!matched) {
      if (sawLexicalEscape || sawSymlinkEscape) throw httpError(403, '文件路径超出团队工作区边界');
      throw httpError(404, '文件不存在');
    }
  }

  const stats = statSync(matched.targetReal);
  if (!stats.isFile()) throw httpError(400, '目标路径不是普通文件');

  const fd = openSync(matched.targetReal, 'r');
  let bytesRead;
  const buffer = Buffer.alloc(MAX_FILE_PREVIEW_BYTES + 1);
  try {
    bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  const slice = buffer.subarray(0, Math.min(bytesRead, MAX_FILE_PREVIEW_BYTES));
  if (slice.includes(0)) throw httpError(400, '不支持预览二进制文件');

  return {
    path: relative(matched.root.real, matched.targetReal).replace(/\\/g, '/'),
    rootKind: matched.root.kind,
    memberId: matched.root.memberId,
    memberName: matched.root.memberName,
    size: stats.size,
    truncated: bytesRead > MAX_FILE_PREVIEW_BYTES || stats.size > MAX_FILE_PREVIEW_BYTES,
    content: slice.toString('utf8'),
  };
}
