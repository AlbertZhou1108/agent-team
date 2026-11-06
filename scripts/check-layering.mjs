#!/usr/bin/env node
/**
 * 分层检查（P1-4 的可执行门禁）：
 *
 *  规则 A（默认只告警，退出 0）：test/contract/** 的断言不得直接读存储行。
 *    contract 层测试只能断言公共入口的返回值/可观察行为；直接 `store.get/all/run`
 *    会把内部表结构钉进对外契约。迁移到 test/internal/ 或改用公共可观察值属于
 *    后续工作，本脚本先打印计数与文件清单，避免一次性卡住开发。
 *    设 `LAYERING_STRICT_A=1` 可将规则 A 提升为阻断（告警窗口结束后再切换）。
 *
 *  规则 B（严格阻断，退出非 0）：web/src/** 不得 import `electron/` 或根目录
 *    `src/`。前端必须保持纯 Web：桌面原生能力只能经 preload 以可选注入方式提供
 *    （`globalThis.agentTeam?.xxx?.()`），不能反向依赖桌面壳或后端工程。
 *
 * 用法：node scripts/check-layering.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const webSrcDir = join(repoRoot, 'web/src');
const contractDir = join(repoRoot, 'test/contract');

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

/* ---------------------------------- 规则 A --------------------------------- */

// 断言出现即视为「断言行」：assert(...)、assert.equal(...)、assert.match(...) 等。
const ASSERT = /\bassert(?:\.|\s*\()/;
// buggy 写法里也可能是局部 store 变量，因此同时接受 bus.store 与裸 store。
const STORE_ROW_READ = /\b(?:bus\.)?store\.(?:get|all|run)\s*\(/;

function checkContractAsserts() {
  const byFile = new Map();
  let total = 0;
  let fileCount = 0;

  walk(contractDir, (path) => {
    if (!/\.(mjs|js|ts)$/.test(path)) return;
    const source = readFileSync(path, 'utf8');
    let hits = 0;
    for (const [index, line] of source.split('\n').entries()) {
      if (!ASSERT.test(line) || !STORE_ROW_READ.test(line)) continue;
      hits += 1;
      total += 1;
      if (hits === 1) {
        fileCount += 1;
        byFile.set(relativeToRoot(path), { count: 0, lines: [] });
      }
      const entry = byFile.get(relativeToRoot(path));
      entry.count += 1;
      entry.lines.push(index + 1);
    }
  });

  return { total, fileCount, byFile };
}

function reportRuleA() {
  const { total, fileCount, byFile } = checkContractAsserts();
  const label = '[layering] 规则 A（告警）：test/contract 断言不得直接读 store 行';
  if (!total) {
    console.log(`${label} — 通过（0 处）`);
    return 0;
  }
  console.log(`${label} — ${total} 处 / ${fileCount} 文件（迁移到 test/internal 或用公共可观察值）`);
  for (const [file, entry] of [...byFile.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
  )) {
    console.log(`  ${String(entry.count).padStart(3)} 处  ${file}  行 ${entry.lines.join(', ')}`);
  }
  return total;
}

/* ---------------------------------- 规则 B --------------------------------- */

const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/;
// 静态 import / 再导出 / 动态 import / CJS require。SFC 整文件扫描即可覆盖 script。
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
  // 相对/绝对路径先解析成真实位置，再判断是否越过 web/src 落进仓库根 src/ 或 electron/。
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

function checkWebImports() {
  const violations = [];
  let scanned = 0;
  walk(webSrcDir, (path) => {
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
  return { violations, scanned };
}

function reportRuleB() {
  const { violations, scanned } = checkWebImports();
  const label = '[layering] 规则 B（阻断）：web/src 不得 import electron/ 或根目录 src/';
  if (!violations.length) {
    console.log(`${label} — 通过（扫描 ${scanned} 个文件，0 处违规）`);
    return [];
  }
  console.log(`${label} — ${violations.length} 处违规：`);
  for (const violation of violations) {
    console.log(`  ${violation.file}:${violation.line}  import '${violation.specifier}'  — ${violation.reason}`);
  }
  return violations;
}

/* ---------------------------------- 入口 ---------------------------------- */

const ruleATotal = reportRuleA();
const ruleBViolations = reportRuleB();

const strictA = process.env.LAYERING_STRICT_A === '1';
if (ruleBViolations.length) {
  console.error('[layering] 失败：web/src 违反纯 Web 红线。');
  process.exitCode = 1;
} else if (strictA && ruleATotal) {
  console.error('[layering] 失败：规则 A 已按 LAYERING_STRICT_A=1 提升为阻断。');
  process.exitCode = 1;
} else {
  console.log('[layering] 通过');
}
