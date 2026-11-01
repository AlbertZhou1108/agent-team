#!/usr/bin/env node
/**
 * 设计治理检查(设计逻辑框架 §9 的技术化):
 *  1. 组件与业务代码不得出现字面量动效时长 —— 必须消费动效契约变量。
 *  2. 业务代码不得出现十六进制色值字面量 —— 必须消费语义令牌。
 *  3. data-surface 的取值必须在表面角色注册表内。
 *  4. CSS 中的 --surface-* 变量消费必须指向已注册的角色。
 * 违例以非零码退出,阻止进入提交;豁免清单在本文件底部显式维护。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../web/src', import.meta.url));

const SURFACE_ROLES = new Set([
  'nav-panel',
  'context-panel',
  'action',
  'input',
  'reading',
  'overlay',
  'media',
]);

const COMPONENT_VARIABLES = new Set([...readFileSync(join(srcDir, 'theme/component-contract.ts'), 'utf8').matchAll(/['"](--component-[a-z-]+)['"]:/g)].map(match => match[1]));

// 豁免:未接线的引擎组件、测试文件、数据级色板(内容而非样式)。
const EXEMPT_PATHS = [
  /components\/ui\/message-scroller\//,
  /\.test\./,
  /shared\/team-colors\.ts/,
];

const CHECKS = [
  {
    name: '折叠必须复用 Disclosure / Collapsible，不能另写 details',
    pattern: /<(?:details|summary)\b/,
    scopes: ['components', 'features', 'pages', 'app'],
  },
  {
    name: '组件变量未在五维契约注册',
    pattern: /--component-[a-z-]+/,
    scopes: ['components', 'features', 'pages', 'app', 'styles'],
    validate: match => COMPONENT_VARIABLES.has(match[0]),
    extract: match => match[0],
  },
  {
    name: '公共组件不得判断设计预设(应消费解析参数)',
    pattern: /from ['"][^'"]*theme\/design-presets|data-design-preset/,
    scopes: ['components', 'app'],
  },

  {
    name: '字面量动效时长(应消费 --motion-duration-*)',
    pattern: /duration-\[\d|duration-\d+/,
    scopes: ['components', 'features', 'pages', 'app'],
  },
  {
    name: '十六进制色值字面量(应消费语义令牌)',
    pattern: /#[0-9a-fA-F]{6}\b/,
    scopes: ['components', 'features', 'pages', 'app'],
  },
  {
    name: 'data-surface 取值未注册',
    // (?<![:\w]) 只匹配字面量,放过 :data-surface="role" 这类绑定(Surface 组件内部)。
    pattern: /(?<![:\w])data-surface="([^"]+)"/,
    scopes: ['components', 'features', 'pages', 'app'],
    validate: (match) => SURFACE_ROLES.has(match[1]),
    extract: (match) => match[1],
  },
  {
    name: 'Surface role 取值未注册',
    pattern: /<Surface\b[^>]*\b(?<!:)role="([^"]+)"/,
    scopes: ['components', 'features', 'pages', 'app'],
    validate: (match) => SURFACE_ROLES.has(match[1]),
    extract: (match) => match[1],
  },
  {
    name: '--surface-* 消费了未注册的角色',
    pattern: /--surface-([a-z-]+?)-(?:bg|blur)\b/,
    scopes: ['styles'],
    validate: (match) => SURFACE_ROLES.has(match[1]),
    extract: (match) => match[1],
  },
];

const problems = [];

function walk(dir, visit) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, visit);
    else visit(path);
  }
}

for (const check of CHECKS) {
  for (const scope of check.scopes) {
    const dir = join(srcDir, scope);
    walk(dir, (path) => {
      if (!/\.(vue|ts|css)$/.test(path)) return;
      const rel = relative(srcDir, path).replaceAll('\\', '/');
      if (EXEMPT_PATHS.some((re) => re.test(rel))) return;
      const source = readFileSync(path, 'utf8');
      const lines = source.split('\n');
      lines.forEach((line, index) => {
        const match = line.match(check.pattern);
        if (!match) return;
        if (check.validate && check.validate(match)) return;
        problems.push(`  ${rel}:${index + 1}  [${check.name}] ${check.extract ? check.extract(match) : line.trim().slice(0, 60)}`);
      });
    });
  }
}

if (problems.length) {
  console.error(`设计治理检查未通过(${problems.length} 处):`);
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('设计治理检查通过。');
