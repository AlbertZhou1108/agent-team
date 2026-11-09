import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// `node --check` 只验语法，不解析导入。文件搬家、改名、删文件时，悬空的
// `from './x.mjs'` 会一路绿灯到运行时才炸 ERR_MODULE_NOT_FOUND，所以这里补一遍
// 静态解析：把每个相对 specifier 解析成绝对路径，看文件在不在。

const files = [];
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) check(path);
    else if (/\.(mjs|js)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status) process.exit(result.status);
      if (path.endsWith('.mjs')) files.push(path);
    }
  }
}
for (const directory of ['src', 'web', 'test', 'scripts', 'electron']) check(directory);
console.log('Syntax checks passed');

/** 去掉注释但保留行号：块注释里的换行原样留下，其余字符换成空格。 */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += source[i + 1] ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)'(\.[^']*)'/g;
const broken = [];
let specifiers = 0;
for (const file of files) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(SPECIFIER)) {
      specifiers += 1;
      const base = resolve(dirname(file), match[1]);
      // Node ESM 要求带扩展名，但目录式写法在 JS 里仍可能存在，一并容忍。
      const ok = [base, `${base}.mjs`, `${base}.js`, resolve(base, 'index.mjs')].some(existsSync);
      if (!ok) broken.push(`${relative(process.cwd(), file)}:${index + 1}  ${match[1]}`);
    }
  }
}
if (broken.length) {
  console.error(`[imports] ${broken.length} 处相对导入解析不到：`);
  for (const item of broken.slice(0, 20)) console.error(`  ${item}`);
  if (broken.length > 20) console.error(`  …另有 ${broken.length - 20} 处`);
  process.exit(1);
}
console.log(`Import checks passed (${files.length} 个文件，${specifiers} 个相对导入)`);

// 文档里的源码链接：文件搬家/改名后，guide 与 skills 里的 `../src/x.mjs` 会静默失效。
const docs = ['README.md'];
for (const name of readdirSync('guide')) if (name.endsWith('.md')) docs.push(`guide/${name}`);
(function walkDocs(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walkDocs(path);
    else if (path.endsWith('.md')) docs.push(path);
  }
})('skills');
const deadLinks = [];
let links = 0;
for (const doc of docs) {
  for (const match of readFileSync(doc, 'utf8').matchAll(/\]\(([^)\s]+\.mjs)\)/g)) {
    links += 1;
    if (!existsSync(resolve(dirname(doc), match[1]))) deadLinks.push(`${doc} → ${match[1]}`);
  }
}
if (deadLinks.length) {
  console.error(`[docs] ${deadLinks.length} 个源码链接指向不存在的文件：`);
  for (const item of deadLinks.slice(0, 20)) console.error(`  ${item}`);
  process.exit(1);
}
console.log(`Doc link checks passed (${docs.length} 篇文档，${links} 个源码链接)`);
