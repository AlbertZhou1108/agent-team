// 主动唤醒的退避表：前三次递增，之后交给 attempts 阈值转永久降级。
import test from 'node:test';
import assert from 'node:assert/strict';
import { wakeBackoffMs } from '../../control-plane.mjs';

test('wake backoff grows then stops', () => {
  assert.equal(wakeBackoffMs(1), 60_000);
  assert.equal(wakeBackoffMs(2), 5 * 60_000);
  assert.equal(wakeBackoffMs(3), 15 * 60_000);
  assert.equal(wakeBackoffMs(4), null);
  assert.equal(wakeBackoffMs(0), null);
});
