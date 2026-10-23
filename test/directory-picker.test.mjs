import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { chooseDirectory } from '../src/directory-picker.mjs';
test('native folder picker returns an absolute directory and preserves cancellation', async () => {
  const selected = await chooseDirectory({ platform: 'darwin', run: async (cmd, args) => {
    assert.equal(cmd, '/usr/bin/osascript'); assert.match(args[1], /choose folder/);
    return { stdout: tmpdir() + '\n' };
  } });
  assert.equal(selected.path, tmpdir());
  assert.deepEqual(await chooseDirectory({ platform: 'darwin', run: async () => ({ stdout: '\n' }) }), { path: null });
  await assert.rejects(chooseDirectory({ platform: 'linux' }), /仅支持 macOS/);
  await assert.rejects(chooseDirectory({ platform: 'darwin', run: async () => ({ stdout: 'relative\n' }) }), /有效文件夹/);
});
