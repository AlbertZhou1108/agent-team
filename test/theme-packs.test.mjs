import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'theme-packs-'));
  const server = await startServer({ directory, hosts: new Map() });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { server, url: server.url };
}

// 服务端只做结构校验(可解析、键数、值类型/长度),不检查颜色语义。
function tokenMap() {
  const tokens = {};
  for (let index = 0; index < 29; index += 1) tokens[`token-${index}`] = `oklch(0.5 0 ${index})`;
  return JSON.stringify(tokens);
}

test('theme packs CRUD via bus', async t => {
  const { server } = await setup(t);
  const bus = server.bus;

  const created = bus.createThemePack({ name: '我的主题', light: tokenMap(), dark: tokenMap() });
  assert.equal(created.name, '我的主题');
  assert.ok(created.id, '服务端生成 id');
  assert.equal(typeof created.light, 'string');
  assert.equal(bus.themePacks().length, 1);

  // 重名拒绝 + 名称校验
  assert.throws(() => bus.createThemePack({ name: '我的主题', light: tokenMap(), dark: tokenMap() }), /已存在/);
  assert.throws(() => bus.createThemePack({ name: '  ', light: tokenMap(), dark: tokenMap() }), /名称/);
  assert.throws(() => bus.createThemePack({ name: 'x'.repeat(61), light: tokenMap(), dark: tokenMap() }), /名称/);

  // 结构校验:light/dark 必须是可解析 JSON、值必须是字符串
  assert.throws(() => bus.createThemePack({ name: '坏包', light: '不是json', dark: tokenMap() }), /有效 JSON/);
  assert.throws(() => bus.createThemePack({ name: '坏包', light: tokenMap(), dark: '{"a":1}' }), /非法变量值/);

  // 删除 + 不存在防护;内置主题不是库行,天然删不到
  assert.deepEqual(bus.deleteThemePack(created.id), { deleted: created.id });
  assert.throws(() => bus.deleteThemePack(created.id), /不存在/);
  assert.throws(() => bus.deleteThemePack('classic'), /不存在/);
});

test('theme packs HTTP routes', async t => {
  const { url } = await setup(t);

  const create = await fetch(new URL('/api/theme-packs', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP主题', light: tokenMap(), dark: tokenMap() }),
  });
  assert.equal(create.status, 200);
  const pack = await create.json();
  assert.equal(pack.name, 'HTTP主题');

  const list = await (await fetch(new URL('/api/theme-packs', url))).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'HTTP主题');

  const bad = await fetch(new URL('/api/theme-packs', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP主题', light: tokenMap(), dark: tokenMap() }),
  });
  assert.equal(bad.status, 400);

  const removed = await fetch(new URL(`/api/theme-packs/${encodeURIComponent(pack.id)}/delete`, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(removed.status, 200);

  const missing = await fetch(new URL(`/api/theme-packs/${encodeURIComponent(pack.id)}/delete`, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(missing.status, 400);
});
