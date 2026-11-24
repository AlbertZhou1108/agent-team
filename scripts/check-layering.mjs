#!/usr/bin/env node
/**
 * 纯 Web 分层检查（严格阻断）：
 *   web/src/** 与 web/tests/** 不得 import `electron/` 或根目录 `src/`。
 *   前端必须保持纯 Web：桌面原生能力只能经 preload 以可选注入方式提供
 *   （`globalThis.agentTeam?.xxx?.()`），不能反向依赖桌面壳或后端工程。
 *
 * （原规则 A contract/ 测试 ratchet 基线已随 ADR 0016 退役。）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const webSrcDir = join(repoRoot, 'web/src');
const webTestsDir = join(repoRoot, 'web/tests');

function walk(directory, onFile) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, onFile);
    else onFile(path);
  }
}

const posix = (path) => path.split(sep).join('/');
const relativeToRoot = (path) => posix(relative(repoRoot, path));

const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/;
const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[^'"]*?\bfrom\s*)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function importViolation(specifier, file) {
  if (specifier === 'electron' || specifier.startsWith('electron/')) {
    return '导入 Electron 包（应经 preload 可选注入）';
  }
  if (specifier.startsWith('src/') || specifier.startsWith('electron/')) {
    return '以根目录路径导入后端/桌面壳';
  }
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const resolved = resolve(dirname(file), specifier);
  const rel = posix(relative(repoRoot, resolved));
  if (rel === 'src' || rel.startsWith('src/')) return '越过 web/src 导入后端 src/';
  if (rel === 'electron' || rel.startsWith('electron/')) return '越过 web/src 导入 electron/';
  return null;
}

function lineOf(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function scanWebImports() {
  const violations = [];
  let scanned = 0;
  for (const directory of [webSrcDir, webTestsDir]) {
    if (!existsSync(directory)) continue;
    walk(directory, (path) => {
      if (!SOURCE_FILE.test(path)) return;
      scanned += 1;
      const source = readFileSync(path, 'utf8');
      for (const pattern of IMPORT_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source))) {
          const reason = importViolation(match[1], path);
          if (!reason) continue;
          violations.push({
            file: relativeToRoot(path),
            line: lineOf(source, match.index),
            specifier: match[1],
            reason,
          });
        }
      }
    });
  }
  return { violations, scanned };
}

const { violations, scanned } = scanWebImports();
const label = '[layering] 纯 Web 边界（阻断）：web/src 与 web/tests 不得 import electron/ 或根目录 src/';
if (!violations.length) {
  console.log(`${label} — 通过（扫描 ${scanned} 个文件，0 处违规）`);
} else {
  console.log(`${label} — ${violations.length} 处违规：`);
  for (const violation of violations) {
    console.log(`  ${violation.file}:${violation.line}  import '${violation.specifier}'  — ${violation.reason}`);
  }
  console.error('[layering] 失败：web/src 或 web/tests 违反纯 Web 红线。');
  process.exitCode = 1;
}
