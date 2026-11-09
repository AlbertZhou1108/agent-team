// CLI 参数语义：`direct 文本` 是位置参数，历史写法 `--text` 仍然兼容。
// 同时钉住「指令文本非法时在业务层报错」—— 不能让它以 SQLite 绑定错误的形式漏到用户面前。
import test from 'node:test';
import assert from 'node:assert/strict';
import { directText } from '../../src/cli.mjs';
import { homeWorkbench } from '../../src/productivity.mjs';
import { busScenario } from '../support/fixture.mjs';

test('direct 的文本取位置参数，也兼容 --text，位置参数优先', () => {
  assert.equal(directText(['direct', '你好'], {}), '你好');
  assert.equal(directText(['direct'], { text: '开关写法' }), '开关写法');
  assert.equal(directText(['direct', '  前后空格  '], {}), '前后空格');
  assert.equal(directText(['direct', '位置'], { text: '开关' }), '位置');
  // 缺省返回空串，交给业务层统一报错，不在解析层抛类型错误。
  assert.equal(directText(['direct'], {}), '');
  assert.equal(directText(['direct'], { text: undefined }), '');
});

test('指令文本非法时在业务层报错，而不是落到存储绑定', async t => {
  const { bus, group } = await busScenario(t, { members: [] });
  assert.throws(() => bus.directive(group.id, undefined), /指令须为 1–48000 字符/);
  assert.throws(() => bus.directive(group.id, '   '), /指令须为 1–48000 字符/);
  assert.throws(() => bus.directive(group.id, 'x'.repeat(48001)), /指令须为 1–48000 字符/);

  const receipt = bus.directive(group.id, '正常指令');
  assert.match(receipt.messageId, /^[\w-]{36}$/);
  // 用户自己发出的指令不算未读（未读只统计发给用户的消息）。
  assert.equal(homeWorkbench(bus).unreadTotal, 0);
});
