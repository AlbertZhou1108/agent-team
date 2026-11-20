// surface 判断的唯一入口:桌面连接跟随会话目录,CLI 必须显式提供。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SURFACES, surfaceFollowsConversation } from '../../hosts/definitions.mjs';

test('桌面连接跟随会话当前目录', () => {
  assert.equal(surfaceFollowsConversation(SURFACES.desktop), true);
});

test('CLI 与未知连接不跟随会话目录', () => {
  assert.equal(surfaceFollowsConversation(SURFACES.cli), false);
  assert.equal(surfaceFollowsConversation(undefined), false);
  assert.equal(surfaceFollowsConversation('desktopish'), false);
});
