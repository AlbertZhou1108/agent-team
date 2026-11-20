// codex 宿主文本回传的兜底:事件 threadId 不匹配或 item/completed 缺失时,
// 仍应把回合文本交回框架,避免"回合完成但回复丢失"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEventContext, turnText } from '../../hosts/codex/index.mjs';

test('resolveEventContext 优先按 threadId 命中', () => {
  const a = { text: 'A' };
  const b = { text: 'B' };
  const active = new Map([['thread-1', a], ['thread-2', b]]);
  assert.equal(resolveEventContext(active, 'thread-1'), a);
  assert.equal(resolveEventContext(active, 'thread-2'), b);
});

test('resolveEventContext 在单活跃回合时对未知 threadId 兜底', () => {
  const only = { text: 'OK' };
  const active = new Map([['thread-1', only]]);
  assert.equal(resolveEventContext(active, 'thread-other'), only);
  assert.equal(resolveEventContext(active, undefined), only);
});

test('resolveEventContext 多活跃回合时不猜测', () => {
  const active = new Map([['thread-1', { text: 'A' }], ['thread-2', { text: 'B' }]]);
  assert.equal(resolveEventContext(active, 'thread-other'), undefined);
});

test('turnText 优先 item/completed,缺失时用流式累积兜底', () => {
  assert.equal(turnText({ text: 'OK', streamed: 'O' }), 'OK');
  assert.equal(turnText({ text: '', streamed: 'OK' }), 'OK');
  assert.equal(turnText({ text: '', streamed: '' }), '');
  assert.equal(turnText(undefined), '');
});
