// 发布门约束:外部主控工具面只提供归档,不提供任何永久删除入口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../../control-plane.mjs', import.meta.url)), 'utf8');
const names = [...source.matchAll(/\['((?:control|team)_[a-z_]+)'/g)].map(match => match[1]);

test('外部主控工具面不提供永久删除', () => {
  assert.ok(names.length > 0, '应能解析出控制面工具名');
  assert.deepEqual(
    names.filter(name => /delete|remove|purge|destroy/i.test(name)),
    [],
    '外部主控不得拥有删除类工具',
  );
});

test('归档是唯一的下线动作,且明确不能永久删除', () => {
  assert.ok(names.includes('team_archive'), '归档工具必须存在');
  assert.match(source, /team_archive', '归档受控团队；外部主控不能永久删除团队/);
});
