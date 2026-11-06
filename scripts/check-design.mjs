#!/usr/bin/env node
/**
 * 设计治理检查(设计逻辑框架 §9 的技术化):
 *  1. 组件与业务代码不得出现字面量动效时长 —— 必须消费动效契约变量。
 *  2. 业务代码不得出现十六进制色值字面量 —— 必须消费语义令牌。
 *  3. data-surface 的取值必须在表面角色注册表内。
 *  4. CSS 中的 --surface-* 变量消费必须指向已注册的角色。
 *  5. 动效只能经语义别名(--component-*)消费,不得直读 --motion-*(契约原语)。
 *  6. 同一模板内不得卡片套卡片:Card 里再开 Card 或折叠卡片,一律视为层级失控。
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

// 豁免:测试文件、数据级色板(内容而非样式)。
// 引擎组件(message-scroller)已接入动效契约,不再整目录豁免。
const EXEMPT_PATHS = [
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
    name: '字面量动效时长(应消费动效契约)',
    pattern: /duration-\[\d|duration-\d+/,
    scopes: ['components', 'features', 'pages', 'app'],
  },
  {
    // 分层要靠检查兜住:组件与页面只认「这是哪种变化」(--component-*),
    // 具体毫秒与曲线归契约层。直读 --motion-* 等于绕过语义层,等下次调档就会漏。
    name: '直读动效原语(应消费 --component-* 语义别名)',
    pattern: /--motion-(?:duration|ease|pace)[a-z-]*/,
    scopes: ['components', 'features', 'pages', 'app', 'shared', 'styles'],
    // 契约定义处与 JS 侧唯一读取入口不在此列:前者是原语的家,后者必须读 --motion-pace。
    exempt: [/^shared\/motion\.ts$/, /^styles\/globals\.css$/],
  },
  {
    name: '十六进制色值字面量(应消费语义令牌)',
    // 覆盖 3/4/6/8 位写法:#fff、#ffff、#ffffff、#ffffff80 都算绕过。
    pattern: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/,
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
    name: '绑定表达式里的字面量 data-surface 未注册',
    // :data-surface="'nav-panel'" 这类把字面量塞进绑定的写法同样要过注册表。
    pattern: /:data-surface=["']\s*'([^']+)'\s*["']/,
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

/**
 * 卡片套卡片(DESIGN.md「避免卡片中反复嵌套卡片」)。
 * 只看模板:同层出现第二个卡片面(含 Disclosure 的 card 变体)即违例 ——
 * 区域内应该用分区标题、分割线与间距,而不是再造一层边框。
 * 分层组件的自身实现(components/ui)不在检查范围内。
 */
const CARD_SCOPES = ['features', 'pages', 'app'];
const CARD_OPEN = /<(\/)?(Card|Disclosure)\b([^>]*)>/g;

// 样式块里的动效时长同样必须消费契约变量:transition/animation 的裸 ms/s 不允许。
// 只看 <style> 块,避免误伤 JS 里的超时数字。
const STYLE_DURATION = /(?:^|[^\w-])(\d+(?:\.\d+)?)(m?s)\b/g;
function checkStyleDurations(path, rel, problems) {
  const source = readFileSync(path, 'utf8');
  for (const block of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    // 注释里提到毫秒不算违规;用等长空白替换注释,保持行号不漂移。
    const body = block[1].replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
    const open = block[0].indexOf('>') + 1;
    const baseLine = source.slice(0, block.index + open).split('\n').length - 1;
    for (const match of body.matchAll(STYLE_DURATION)) {
      problems.push(`  ${rel}:${baseLine + body.slice(0, match.index).split('\n').length}  [<style> 内动效时长] ${match[1]}${match[2]}`);
    }
  }
}

function checkCardNesting(path, rel) {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf('<template>');
  if (start < 0) return;
  const body = source.slice(start);
  const baseLine = source.slice(0, start).split('\n').length - 1;
  const stack = [];
  let match;
  CARD_OPEN.lastIndex = 0;
  while ((match = CARD_OPEN.exec(body))) {
    const closing = Boolean(match[1]);
    const tag = match[2];
    const attrs = match[3] ?? '';
    const selfClosing = /\/\s*$/.test(attrs);
    const line = baseLine + body.slice(0, match.index).split('\n').length;
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === tag) { stack.splice(index, 1); break; }
      }
      continue;
    }
    const isCardFace = tag === 'Card' || /variant="card"/.test(attrs);
    if (isCardFace) {
      const outer = stack.filter((entry) => entry.card).at(-1);
      if (outer) {
        problems.push(`  ${rel}:${line}  [卡片套卡片] <${tag}> 位于第 ${outer.line} 行开始的卡片面内`);
      }
      if (!selfClosing) stack.push({ tag, line, card: true });
    } else if (!selfClosing) {
      stack.push({ tag, line, card: false });
    }
  }
}

for (const scope of CARD_SCOPES) {
  walk(join(srcDir, scope), (path) => {
    if (!path.endsWith('.vue')) return;
    const rel = relative(srcDir, path).replaceAll('\\', '/');
    if (EXEMPT_PATHS.some((re) => re.test(rel))) return;
    checkCardNesting(path, rel);
    checkStyleDurations(path, rel, problems);
  });
}

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
      if (check.exempt?.some((re) => re.test(rel))) return;
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
