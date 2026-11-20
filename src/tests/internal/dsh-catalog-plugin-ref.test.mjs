import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';

test('DSH 目录探测写入 patch 的插件模块路径必须真实存在', () => {
  const source = readFileSync(new URL('../../member/dsh/index.mjs', import.meta.url), 'utf8');
  const base = new URL('../../member/dsh/index.mjs', import.meta.url);
  const refs = [...source.matchAll(/new URL\('(\.\/[^']+)'/g)].map(match => match[1]);
  assert.ok(refs.length > 0, 'index.mjs 应至少引用一个相对插件模块');
  assert.ok(source.includes("'agent-team-model-catalog'"), '目录探测应插入 agent-team 模型目录插件');
  for (const ref of refs) {
    assert.ok(existsSync(new URL(ref, base)), `引用的插件模块不存在: ${ref}`);
  }
});
