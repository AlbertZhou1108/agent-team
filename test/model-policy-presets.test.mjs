import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'policy-presets-'));
  const server = await startServer({ directory, hosts: new Map() });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { server, url: server.url };
}

test('model policy presets CRUD via bus', async t => {
  const { server } = await setup(t);
  const bus = server.bus;
  const created = bus.createModelPolicyPreset({ name: '精简成本', mode: 'user', rules: '成本优先的自定义规则' });
  assert.equal(created.name, '精简成本');
  assert.equal(created.mode, 'user');
  assert.equal(bus.modelPolicyPresets().length, 1);

  // 重命名 + 重名拒绝
  const renamed = bus.renameModelPolicyPreset(created.id, '严格审查');
  assert.equal(renamed.name, '严格审查');
  bus.createModelPolicyPreset({ name: '精简成本', rules: '另一份规则' });
  assert.throws(() => bus.renameModelPolicyPreset(renamed.id, '精简成本'), /已存在/);

  // 自建配置恒为用户配置(智能策略是代码内置的,不可自建)
  const smartAttempt = bus.createModelPolicyPreset({ name: '误建智能', mode: 'smart', rules: '规则' });
  assert.equal(smartAttempt.mode, 'user');

  // 覆盖保存 + normalize(空规则回填默认用户模板)
  const saved = bus.saveModelPolicyPreset(renamed.id, { rules: '' });
  assert.equal(saved.mode, 'user');
  assert.ok(saved.rules.length > 0, '空规则回填默认用户模板');

  // 正在使用的配置不允许删除:引用保持不变
  const active = bus.createModelPolicyPreset({ name: '待删激活', rules: '激活中规则' });
  bus.updateModelPolicy({ mode: 'user', rules: '激活中规则', presetId: active.id });
  assert.equal(bus.modelPolicy().preset_id, active.id);
  assert.throws(() => bus.deleteModelPolicyPreset(active.id), /正在使用中/);
  assert.equal(bus.modelPolicy().preset_id, active.id, '拒绝删除后引用保持不变');
  assert.ok(bus.modelPolicyPresets().some(preset => preset.id === active.id), '配置仍然存在');

  // 切走后即可删除
  bus.updateModelPolicy({ mode: 'user', rules: '换成别的规则' });
  assert.deepEqual(bus.deleteModelPolicyPreset(active.id), { deleted: active.id });

  // 删除 + 不存在防护
  assert.deepEqual(bus.deleteModelPolicyPreset(saved.id), { deleted: saved.id });
  assert.throws(() => bus.deleteModelPolicyPreset(saved.id), /不存在/);
});

test('model policy presets validate name and rules', async t => {
  const { server } = await setup(t);
  const bus = server.bus;
  assert.throws(() => bus.createModelPolicyPreset({ name: '  ', rules: 'x' }), /名称/);
  assert.throws(() => bus.createModelPolicyPreset({ name: 'x'.repeat(61), rules: 'x' }), /名称/);
  assert.throws(() => bus.createModelPolicyPreset({ name: '好', rules: 'x'.repeat(48001) }), /过长/);
  // 模式不由调用方指定:自建配置恒为用户配置
  assert.equal(bus.createModelPolicyPreset({ name: '好', mode: 'unknown', rules: 'x' }).mode, 'user');
});

test('activating a policy records only the explicitly requested source preset', async t => {
  const { server } = await setup(t);
  const bus = server.bus;
  const first = bus.createModelPolicyPreset({ name: '配置A', mode: 'user', rules: '同一份规则' });
  const second = bus.createModelPolicyPreset({ name: '配置B', mode: 'user', rules: '同一份规则' });
  assert.notEqual(first.id, second.id, '配置有唯一 id');

  // 显式指定来源:即使内容相同也记录为指定那一条
  const activated = bus.updateModelPolicy({ mode: 'user', rules: '同一份规则', presetId: second.id });
  assert.equal(activated.preset_id, second.id);

  // 不指定来源时不得靠文本猜测:同文配置不会被误认作来源
  const unsourced = bus.updateModelPolicy({ mode: 'user', rules: '同一份规则' });
  assert.equal(unsourced.preset_id, null);

  // 内置默认规则用哨兵 id 记录
  const builtin = bus.updateModelPolicy({ mode: 'user', rules: '采用用户配置模型策略。', presetId: '__builtin_default__' });
  assert.equal(builtin.preset_id, '__builtin_default__');

  // 手动编辑的规则没有来源
  const manual = bus.updateModelPolicy({ mode: 'user', rules: '手写的新规则' });
  assert.equal(manual.preset_id, null);

  // 不存在的配置 id 被拒绝
  assert.throws(() => bus.updateModelPolicy({ mode: 'user', rules: 'x', presetId: 'missing' }), /配置不存在/);
});

test('model policy presets HTTP routes', async t => {
  const { url } = await setup(t);
  const create = await fetch(new URL('/api/model-policy/presets', url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP配置', mode: 'user', rules: '规则内容' }),
  });
  assert.equal(create.status, 200);
  const preset = await create.json();
  assert.equal(preset.name, 'HTTP配置');

  const rename = await fetch(new URL(`/api/model-policy/presets/${preset.id}/rename`, url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP改名' }),
  });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).name, 'HTTP改名');

  const save = await fetch(new URL(`/api/model-policy/presets/${preset.id}/save`, url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'smart', rules: '新内容' }),
  });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).rules, '新内容');

  const list = await (await fetch(new URL('/api/model-policy/presets', url))).json();
  assert.equal(list.length, 1);

  const bad = await fetch(new URL('/api/model-policy/presets', url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP改名', mode: 'user', rules: 'x' }),
  });
  assert.equal(bad.status, 400);

  const removed = await fetch(new URL(`/api/model-policy/presets/${preset.id}/delete`, url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(removed.status, 200);
});
