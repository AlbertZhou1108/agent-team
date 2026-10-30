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
  await assert.rejects(chooseDirectory({ platform: 'unsupported' }), /不支持/);
  await assert.rejects(chooseDirectory({ platform: 'darwin', run: async () => ({ stdout: 'relative\n' }) }), /有效文件夹/);
});

test('Windows picker uses an STA PowerShell dialog and preserves Unicode paths', async () => {
  const result = await chooseDirectory({ platform: 'win32', run: async (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert.ok(args.includes('-STA'));
    assert.match(Buffer.from(args.at(-1), 'base64').toString('utf16le'), /FolderBrowserDialog/);
    return { stdout: tmpdir() + '\r\n' };
  } });
  assert.equal(result.path, tmpdir());
  assert.deepEqual(await chooseDirectory({ platform: 'win32', run: async () => ({ stdout: '' }) }), { path: null });
});

test('Linux picker falls back to kdialog and handles cancel or missing dependencies', async () => {
  const commands = [];
  assert.deepEqual(await chooseDirectory({ platform: 'linux', run: async command => {
    commands.push(command);
    if (command === 'zenity') throw Object.assign(new Error(), { code: 'ENOENT' });
    return { stdout: tmpdir() + '\n' };
  } }), { path: tmpdir() });
  assert.deepEqual(commands, ['zenity', 'kdialog']);
  assert.deepEqual(await chooseDirectory({ platform: 'linux', run: async () => { throw Object.assign(new Error(), { code: 1 }); } }), { path: null });
  await assert.rejects(chooseDirectory({ platform: 'linux', run: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), /zenity 或 kdialog/);
});
