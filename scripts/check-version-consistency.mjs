#!/usr/bin/env node
/**
 * 版本一致性与文档漂移检查。
 *
 * - `web/package.json` 的版本必须等于根 `package.json`（开发期就应一致）。
 * - `src/version.mjs` 必须继续从根 `package.json` 读版本（单一来源）。
 * - README 的下载版本按发布约定在对应 Release 发布后更新，默认只提示；
 *   发布流程里可传 `--readme-version=vX.Y.Z`（或环境变量）把它变成硬检查。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const rootPackage = JSON.parse(read('package.json'));
const webPackage = JSON.parse(read('web/package.json'));
const problems = [];

if (webPackage.version !== rootPackage.version) {
  problems.push(`web/package.json 版本 ${webPackage.version} 与根 package.json ${rootPackage.version} 不一致`);
}
if (!/\bpackage\.json\b/.test(read('src/version.mjs'))) {
  problems.push('src/version.mjs 不再从根 package.json 读取版本（版本不再是单一来源）');
}

const readme = read('README.md');
const releaseVersion = process.argv.slice(2).find(arg => arg.startsWith('--readme-version='))?.split('=')[1]
  ?? process.env.AGENT_TEAM_README_VERSION
  ?? null;
if (releaseVersion) {
  const tag = releaseVersion.startsWith('v') ? releaseVersion : `v${releaseVersion}`;
  if (!readme.includes(`/releases/tag/${tag}`)) problems.push(`README 未包含已发布版本链接 ${tag}`);
} else {
  const latest = `v${rootPackage.version}`;
  if (!readme.includes(latest)) {
    console.log(`[version] 提示：README 尚未更新到 ${latest}（按发布约定，Release 发布后更新；可用 --readme-version=${latest} 作为发布硬检查）`);
  }
}

if (problems.length) {
  console.error('[version] 版本一致性检查未通过：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`[version] 通过：根包与 web 包版本一致（${rootPackage.version}）`);
