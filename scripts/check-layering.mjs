#!/usr/bin/env node
/**
 * 分层检查（P1-4 起，P3-3 收紧为 ratchet）：
 *
 *  规则 A（ratchet，阻断新增违规）：test/contract/** 的断言不得直接读存储行
 *    （`store.get/all/run`）。contract 层测试只能断言公共入口的返回值/可观察行为，
 *    直接读表会把内部表结构钉进对外契约。
 *    - 存量违规记录在 `scripts/layering-baseline.json`（按文件计数）；
 *    - 基线以内的存量只告警；**新增文件或超出基线计数 → 退出 1**；
 *    - 迁移完成后运行 `node scripts/check-layering.mjs --update-baseline` 下调基线；
 *    - 设 `LAYERING_STRICT_A=1` 可忽略基线、任何存量都阻断（最终目标）。
 *
 *  规则 B（严格阻断）：web/src/** 与 web/tests/** 不得 import `electron/` 或根目录 `src/`。
 *    前端必须保持纯 Web：桌面原生能力只能经 preload 以可选注入方式提供
 *    （`globalThis.agentTeam?.xxx?.()`），不能反向依赖桌面壳或后端工程。
 *
 * 用法：
 *   node scripts/check-layering.mjs                   # 检查（npm run check 使用）
 *   node scripts/check-layering.mjs --update-baseline # 迁移后下调基线
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const webSrcDir = join(repoRoot, 'web/src');
const webTestsDir = join(repoRoot, 'web/tests');
const contractDir = join(repoRoot, 'test/contract');
const baselinePath = join(repoRoot, 'scripts/layering-baseline.json');
const updateBaseline = process.argv.includes('--update-baseline');

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
// 局部 store 变量也算：同时接受 bus.store 与裸 store。
const STORE_ROW_READ = /\b(?:bus\.)?store\.(?:get|all|run)\s*\(/;

function scanContractAsserts() {
  const byFile = new Map();
  let total = 0;

  walk(contractDir, (path) => {
    if (!/\.(mjs|js|ts)$/.test(path)) return;
    const source = readFileSync(path, 'utf8');
    let hits = 0;
    for (const [index, line] of source.split('\n').entries()) {
      if (!ASSERT.test(line) || !STORE_ROW_READ.test(line)) continue;
      hits += 1;
      total += 1;
      if (hits === 1) byFile.set(relativeToRoot(path), { count: 0, lines: [] });
      const entry = byFile.get(relativeToRoot(path));
      entry.count += 1;
      entry.lines.push(index + 1);
    }
  });

  const files = Object.fromEntries(
    [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  );
  return { total, files };
}

function readBaseline() {
  if (!existsSync(baselinePath)) {
    console.error(
      `[layering] 失败：缺少基线文件 ${relativeToRoot(baselinePath)}；`
      + '首次使用请运行 node scripts/check-layering.mjs --update-baseline',
    );
    process.exitCode = 1;
    return null;
  }
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    console.error(`[layering] 失败：基线文件无法解析（${error.message}）`);
    process.exitCode = 1;
    return null;
  }
}

function writeBaseline(result) {
  const payload = {
    note: 'check-layering 规则 A 存量基线：test/contract 断言直读 store 行的按文件计数。'
      + '迁移后运行 node scripts/check-layering.mjs --update-baseline 下调；只允许下降，新增由检查阻断。',
    total: result.total,
    files: Object.fromEntries(
      Object.entries(result.files).map(([file, entry]) => [file, entry.count]),
    ),
  };
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function reportRuleA(result, baseline) {
  if (!baseline) return false;
  const allowedFiles = baseline.files ?? {};
  const allowedTotal = Object.values(allowedFiles).reduce((sum, count) => sum + count, 0);
  const label = '[layering] 规则 A（ratchet）：test/contract 断言不得直接读 store 行';

  if (!result.total) {
    console.log(`${label} — 通过（0 处；基线 ${allowedTotal} 处，可用 --update-baseline 同步）`);
    return false;
  }

  const violations = [];
  for (const [file, entry] of Object.entries(result.files)) {
    const allowed = allowedFiles[file] ?? 0;
    if (entry.count > allowed) {
      violations.push({ file, count: entry.count, allowed, added: entry.count - allowed });
    }
  }
  const stale = Object.keys(allowedFiles).filter((file) => !(file in result.files));

  if (!violations.length) {
    console.log(
      `${label} — ${result.total} 处 / ${Object.keys(result.files).length} 文件`
      + `（基线 ${allowedTotal} 处，未超基线；存量只告警）`,
    );
    for (const [file, entry] of Object.entries(result.files)) {
      console.log(`  ${String(entry.count).padStart(3)} 处  ${file}  行 ${entry.lines.join(', ')}`);
    }
    if (result.total < allowedTotal) {
      console.log(
        `[layering] 提示：实际 ${result.total} 处低于基线 ${allowedTotal} 处，`
        + '可运行 --update-baseline 下调基线。',
      );
    }
    if (stale.length) {
      console.log(`[layering] 提示：基线包含已无违规的文件：${stale.join(', ')}；可 --update-baseline 清理。`);
    }
    return false;
  }

  console.log(`${label} — 超出基线 ${violations.reduce((sum, item) => sum + item.added, 0)} 处：`);
  for (const violation of violations) {
    const entry = result.files[violation.file];
    const allowedText = violation.allowed ? `基线 ${violation.allowed} 处` : '基线外新增';
    console.log(
      `  ${String(violation.count).padStart(3)} 处（${allowedText}）  ${violation.file}`
      + `  行 ${entry.lines.join(', ')}`,
    );
  }
  return true;
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

function scanWebImports() {
  const violations = [];
  let scanned = 0;
  // 前端测试统一在 web/tests/，与 web/src/ 同样受纯 Web 红线约束。
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

function reportRuleB() {
  const { violations, scanned } = scanWebImports();
  const label = '[layering] 规则 B（阻断）：web/src 与 web/tests 不得 import electron/ 或根目录 src/';
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

const result = scanContractAsserts();

let ruleAExceedsBaseline = false;
if (updateBaseline) {
  writeBaseline(result);
  console.log(
    `[layering] 基线已更新：${result.total} 处 / ${Object.keys(result.files).length} 文件`
    + ` → ${relativeToRoot(baselinePath)}`,
  );
} else {
  ruleAExceedsBaseline = reportRuleA(result, readBaseline());
}

const ruleBViolations = reportRuleB();
const strictA = process.env.LAYERING_STRICT_A === '1';

if (ruleBViolations.length) {
  console.error('[layering] 失败：web/src 或 web/tests 违反纯 Web 红线。');
  process.exitCode = 1;
} else if (strictA && result.total) {
  console.error('[layering] 失败：规则 A 已按 LAYERING_STRICT_A=1 忽略基线、全量阻断。');
  process.exitCode = 1;
} else if (ruleAExceedsBaseline) {
  console.error(
    '[layering] 失败：规则 A 出现超出基线的违规（新增文件或新增断言行）。'
    + '存量迁移完成后可运行 node scripts/check-layering.mjs --update-baseline 下调基线。',
  );
  process.exitCode = 1;
} else if (!updateBaseline && !process.exitCode) {
  console.log('[layering] 通过');
}
