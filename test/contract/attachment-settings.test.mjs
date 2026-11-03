import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverScenario } from '../support/fixture.mjs';
import { startServer } from '../../src/server.mjs';
import assert from 'node:assert/strict';

async function setup(t, directory = null) {
  return serverScenario(t, { directory });
}

test('attachment settings defaults and updates via bus', async t => {
  const { server } = await setup(t);
  const bus = server.bus;

  // 默认值:表为空时读取内置默认,updated 为 null。
  const defaults = bus.attachmentSettings();
  assert.equal(defaults.maxFileBytes, 5 * 1024 * 1024);
  assert.equal(defaults.maxFilesPerMessage, 4);
  assert.equal(defaults.maxImagePixels, 20_000_000);
  assert.equal(defaults.updated, null);

  // 合法更新:一次提交全部字段,返回持久化后的值。
  const saved = bus.updateAttachmentSettings({ maxFileBytes: 1024, maxFilesPerMessage: 2, maxImagePixels: 1000 });
  assert.equal(saved.maxFileBytes, 1024);
  assert.equal(saved.maxFilesPerMessage, 2);
  assert.equal(saved.maxImagePixels, 1000);
  assert.ok(saved.updated, '保存后应有 updated 时间戳');
  assert.deepEqual(bus.attachmentSettings(), saved);

  // 非法输入:NaN、非有限数、负数、零、小数、过大整数都拒绝,且不改动已保存值。
  for (const invalid of [
    null,
    undefined,
    '字符串',
    [],
    {},
    { maxFileBytes: NaN, maxFilesPerMessage: 4, maxImagePixels: 20_000_000 },
    { maxFileBytes: Infinity, maxFilesPerMessage: 4, maxImagePixels: 20_000_000 },
    { maxFileBytes: -1, maxFilesPerMessage: 4, maxImagePixels: 20_000_000 },
    { maxFileBytes: 0, maxFilesPerMessage: 4, maxImagePixels: 20_000_000 },
    { maxFileBytes: 1.5, maxFilesPerMessage: 4, maxImagePixels: 20_000_000 },
    { maxFileBytes: 1024, maxFilesPerMessage: 2.5, maxImagePixels: 20_000_000 },
    { maxFileBytes: 1024, maxFilesPerMessage: 0, maxImagePixels: 20_000_000 },
    { maxFileBytes: 1024, maxFilesPerMessage: -4, maxImagePixels: 20_000_000 },
    { maxFileBytes: 1024, maxFilesPerMessage: 4, maxImagePixels: NaN },
    { maxFileBytes: 1024, maxFilesPerMessage: 4, maxImagePixels: 20_000_000.5 },
    { maxFileBytes: 2 ** 31, maxFilesPerMessage: 4, maxImagePixels: 20_000_000 },
    { maxFileBytes: 1024, maxFilesPerMessage: 101, maxImagePixels: 20_000_000 },
    { maxFileBytes: 1024, maxFilesPerMessage: 4, maxImagePixels: 2 ** 31 },
    // 字段名不匹配或缺失整数:多一个少一个都不接受
    { maxFileBytes: 1024, maxFilesPerMessage: 4 },
    { maxFileBytes: 1024, maxFilesPerMessage: 4, maxImagePixels: 20_000_000, extra: 1 },
    { maxFileBytes: 1024, maxFilesPerMessage: '4', maxImagePixels: 20_000_000 },
  ]) {
    assert.throws(() => bus.updateAttachmentSettings(invalid), Error, `应拒绝: ${JSON.stringify(invalid)}`);
  }
  assert.deepEqual(bus.attachmentSettings(), saved, '非法输入不得改动已保存设置');

  // 独立检查:attachment_settings 只有一个 singleton 行。
  assert.equal(bus.store.all('SELECT * FROM attachment_settings').length, 1);
});

test('attachment settings persist across restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'attachment-settings-'));
  // 两个 server 复用同一目录:teardown 必须只关闭"当前"server 再删目录。
  // 若沿用 setup() 的 teardown,它会在第二个 server 仍持有数据库文件时删除
  // 目录(Windows 报 EPERM),且失败后第二个 server 泄漏、事件循环永不排空。
  let server = await startServer({ directory, hosts: new Map() });
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  server.bus.updateAttachmentSettings({ maxFileBytes: 2048, maxFilesPerMessage: 3, maxImagePixels: 30_000_000 });
  await server.close();

  // 同目录重建服务:设置值不变(重启持久化),不回落默认。
  server = await startServer({ directory, hosts: new Map() });
  const settings = server.bus.attachmentSettings();
  assert.equal(settings.maxFileBytes, 2048);
  assert.equal(settings.maxFilesPerMessage, 3);
  assert.equal(settings.maxImagePixels, 30_000_000);
});

test('attachment settings HTTP routes', async t => {
  const { url } = await setup(t);

  const initial = await (await fetch(new URL('/api/settings/attachments', url))).json();
  assert.equal(initial.maxFileBytes, 5 * 1024 * 1024);
  assert.equal(initial.maxFilesPerMessage, 4);
  assert.equal(initial.maxImagePixels, 20_000_000);

  const updated = await fetch(new URL('/api/settings/attachments', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxFileBytes: 4096, maxFilesPerMessage: 1, maxImagePixels: 5_000_000 }),
  });
  assert.equal(updated.status, 200);
  const saved = await updated.json();
  assert.equal(saved.maxFileBytes, 4096);
  assert.equal(saved.maxFilesPerMessage, 1);
  assert.equal(saved.maxImagePixels, 5_000_000);

  // GET 读取同一份值;非法提交返回 400 且不改动已保存设置。
  const readBack = await (await fetch(new URL('/api/settings/attachments', url))).json();
  assert.deepEqual(readBack, saved);

  for (const body of [
    { maxFileBytes: -1, maxFilesPerMessage: 1, maxImagePixels: 5_000_000 },
    { maxFileBytes: 4096, maxFilesPerMessage: 1.5, maxImagePixels: 5_000_000 },
    { maxFileBytes: 4096, maxFilesPerMessage: 1 },
  ]) {
    const rejected = await fetch(new URL('/api/settings/attachments', url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(rejected.status, 400, `应拒绝: ${JSON.stringify(body)}`);
  }
  const afterReject = await (await fetch(new URL('/api/settings/attachments', url))).json();
  assert.deepEqual(afterReject, saved);

  // 非 JSON content-type 拒绝;GET 与 POST 沿用既有本地 Host/Origin 校验(由外层统一处理)。
  const wrongType = await fetch(new URL('/api/settings/attachments', url), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'x',
  });
  assert.equal(wrongType.status, 415);
});
