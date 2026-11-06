import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { serverScenario, seedPanelAgent } from '../support/fixture.mjs';
import { startServer } from '../../src/server.mjs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

// 原生 http 请求:可显式设置 Host/Origin/sec-fetch-site,验证外层本地访问校验。
function rawRequest(target, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: target.hostname, port: target.port, path, method, headers },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function setup(t) {
  const { server, bus, directory, url } = await serverScenario(t);
  const agentId = seedPanelAgent(bus);
  return { server, bus, agentId, directory, url };
}

function jpegBuffer(width = 8, height = 8) {
  const raw = { data: Buffer.alloc(width * height * 4, 128), width, height };
  return jpeg.encode(raw, 80).data;
}

function pngBuffer(width = 2, height = 2) {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 1) png.data[index] = index % 255;
  return PNG.sync.write(png);
}

async function upload(url, body, { name = 'a.txt', type = 'text/plain', headers = {} } = {}) {
  return fetch(new URL('/api/panel-agent/attachments', url), {
    method: 'POST',
    headers: {
      'Content-Type': type,
      'X-Agent-Team-Filename': encodeURIComponent(name),
      ...headers,
    },
    body,
  });
}

test('upload succeeds with 201 JSON and no path leakage', async t => {
  const { url } = await setup(t);
  const response = await upload(url, Buffer.from('附件内容'));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  const uploaded = await response.json();
  assert.deepEqual(Object.keys(uploaded).sort(), ['id', 'mediaType', 'name', 'size'], '响应不含本机路径或存储名');
  assert.equal(uploaded.name, 'a.txt');
  assert.equal(uploaded.mediaType, 'text/plain');
  assert.equal(uploaded.size, Buffer.byteLength('附件内容'));
  // 公共下载入口能读回刚上传的内容（不依赖内部附件行）。
  const download = await fetch(new URL(`/api/panel-agent/attachments/${uploaded.id}`, url));
  assert.equal(download.status, 200);
  assert.equal(await download.text(), '附件内容');
});

test('upload validates headers and media type without depending on workspace', async t => {
  const { url, bus } = await setup(t);

  // Panel Agent 没有工作区也能上传:附件副本存数据目录。
  const ok = await upload(url, Buffer.from('x'));
  assert.equal(ok.status, 201);
  bus.store.run('DELETE FROM attachments');

  // 缺少文件名头。
  const noName = await fetch(new URL('/api/panel-agent/attachments', url), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'x',
  });
  assert.equal(noName.status, 400);

  // 文件名头不是百分号编码的合法序列。
  const badName = await fetch(new URL('/api/panel-agent/attachments', url), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Agent-Team-Filename': '%zz' },
    body: 'x',
  });
  assert.equal(badName.status, 400);

  // 类型按扩展名判定,不支持的扩展名 → 415。
  const wrongType = await upload(url, Buffer.from('x'), { name: 'doc.pdf' });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).code, 'unsupported_media_type');

  // Content-Type 只是参考头:声明 text/plain 的 PNG 字节仍按扩展名 .png 走图片校验。
  const png = pngBuffer();
  const mislabeled = await upload(url, png, { name: 'look-ma.png', type: 'text/plain' });
  assert.equal(mislabeled.status, 201);
  const { id: pngId2 } = await mislabeled.json();
  const preview = await fetch(new URL(`/api/panel-agent/attachments/${pngId2}`, url));
  assert.equal(preview.headers.get('content-type'), 'image/png');
  bus.store.run('DELETE FROM attachments');

  // JPEG 全链路:上传 201 → 下载 inline image/jpeg。
  const jpeg = jpegBuffer();
  const jpegUpload = await upload(url, jpeg, { type: 'image/jpeg', name: '相机照片.jpeg' });
  assert.equal(jpegUpload.status, 201);
  const { id: jpegId } = await jpegUpload.json();
  const jpegDownload = await fetch(new URL(`/api/panel-agent/attachments/${jpegId}`, url));
  assert.equal(jpegDownload.headers.get('content-type'), 'image/jpeg');
  assert.equal(jpegDownload.headers.get('content-disposition').startsWith('inline;'), true);

  // 错误 JSON 统一为 {code,error},不泄露绝对路径。
  const errorPayload = await (await upload(url, Buffer.from('not png'), { type: 'image/png', name: 'x.png' })).json();
  assert.ok(errorPayload.error);
  assert.ok(!String(errorPayload.error).includes('/var/folders') && !String(errorPayload.error).includes('/tmp/'));
});

test('upload enforces server-side size limit with 413', async t => {
  const { url, bus } = await setup(t);
  bus.updateAttachmentSettings({ maxFileBytes: 8, maxFilesPerMessage: 4, maxImagePixels: 20_000_000 });
  const response = await upload(url, Buffer.from('x'.repeat(64)));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'payload_too_large');
});

test('upload rejects broken PNG with 422', async t => {
  const { url } = await setup(t);
  const response = await upload(url, Buffer.from('definitely not a png'), { type: 'image/png', name: 'x.png' });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'invalid_content');
  const ok = await upload(url, pngBuffer(), { type: 'image/png', name: 'ok.png' });
  assert.equal(ok.status, 201);
});

test('download serves inline images and attached text with safe headers', async t => {
  const { url } = await setup(t);
  const png = await upload(url, pngBuffer(), { type: 'image/png', name: '截屏 测试.png' });
  const { id: pngId } = await png.json();
  const text = await upload(url, Buffer.from('hello\nworld'), { type: 'text/plain', name: 'notes "quoted".txt' });
  const { id: textId } = await text.json();

  const pngResponse = await fetch(new URL(`/api/panel-agent/attachments/${pngId}`, url));
  assert.equal(pngResponse.status, 200);
  assert.equal(pngResponse.headers.get('content-type'), 'image/png');
  assert.equal(pngResponse.headers.get('content-disposition').startsWith('inline;'), true, '图片 inline 预览');
  assert.equal(pngResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await pngResponse.arrayBuffer()), new Uint8Array(pngBuffer()));

  const textResponse = await fetch(new URL(`/api/panel-agent/attachments/${textId}`, url));
  assert.equal(textResponse.status, 200);
  assert.equal(textResponse.headers.get('content-type'), 'text/plain; charset=utf-8');
  const disposition = textResponse.headers.get('content-disposition');
  assert.equal(disposition.startsWith('attachment;'), true, '文本以下载形式提供');
  // 文件名中的引号被替换为下划线,不注入 header;非 ASCII 走 filename* 百分号编码。
  assert.ok(disposition.includes('filename="notes _quoted_.txt"'), `ASCII 回退名已转义: ${disposition}`);
  assert.ok(disposition.includes("filename*=UTF-8''"), '包含 RFC5987 编码名');
  assert.equal(await textResponse.text(), 'hello\nworld');

  // 同名文件再次上传不覆盖:两个独立附件都可下载。
  const again = await upload(url, Buffer.from('second copy'), { name: 'notes "quoted".txt' });
  const { id: againId } = await again.json();
  assert.notEqual(againId, textId);
  assert.equal(await (await fetch(new URL(`/api/panel-agent/attachments/${againId}`, url))).text(), 'second copy');
});

test('download and delete return 404 for unknown or bound attachments', async t => {
  const { url, bus } = await setup(t);
  const uploaded = await upload(url, Buffer.from('keep'), { name: 'keep.txt' });
  const { id } = await uploaded.json();

  assert.equal((await fetch(new URL(`/api/panel-agent/attachments/${randomUUID()}`, url))).status, 404);
  assert.equal((await fetch(new URL(`/api/panel-agent/attachments/not-a-uuid`, url))).status, 404);

  // 未绑定 DELETE → 204;再删 → 404。
  assert.equal((await fetch(new URL(`/api/panel-agent/attachments/${id}`, url), { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(new URL(`/api/panel-agent/attachments/${id}`, url))).status, 404);
  assert.equal((await fetch(new URL(`/api/panel-agent/attachments/${id}`, url), { method: 'DELETE' })).status, 404);

  // 已绑定 DELETE → 404,与不存在不可区分。
  const bound = await upload(url, Buffer.from('bound'), { name: 'bound.txt' });
  const { id: boundId } = await bound.json();
  const messageId = randomUUID();
  bus.store.run(
    'INSERT INTO panel_messages(id,panel_agent_id,context,role,text,active_team_id,created) VALUES(?,?,?,?,?,?,?)',
    messageId, bus.store.get('SELECT id FROM panel_agents').id, 'private', 'user', '看附件', null, new Date().toISOString(),
  );
  bus.store.transaction(() => bus.attachments.bindTx(bus.store.get('SELECT id FROM panel_agents').id, messageId, [boundId]));
  const boundDelete = await fetch(new URL(`/api/panel-agent/attachments/${boundId}`, url), { method: 'DELETE' });
  assert.equal(boundDelete.status, 404);
  assert.equal((await boundDelete.json()).code, 'not_found');
  // 已绑定附件仍可下载。
  assert.equal((await fetch(new URL(`/api/panel-agent/attachments/${boundId}`, url))).status, 200);
});

test('attachment routes inherit local host and origin validation', async t => {
  const { url } = await setup(t);
  // undici fetch 会忽略 Host/Origin/Sec-Fetch-Site 这类受限头,必须用原生 http 请求验证外层校验。
  const target = new URL(url);

  // Host 不匹配 → 403。
  const badHost = await rawRequest(target, '/api/panel-agent/attachments', {
    method: 'POST',
    headers: { host: 'evil.example:80', 'content-type': 'text/plain', 'x-agent-team-filename': 'a.txt' },
    body: 'x',
  });
  assert.equal(badHost.status, 403);

  // 跨站 sec-fetch-site → 403。
  const crossSite = await rawRequest(target, '/api/panel-agent/attachments', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain', 'x-agent-team-filename': 'a.txt' },
    body: 'x',
  });
  assert.equal(crossSite.status, 403);

  // 跨源 Origin → 403。
  const crossOrigin = await rawRequest(target, '/api/panel-agent/attachments', {
    method: 'POST',
    headers: { origin: 'http://evil.example:80', 'content-type': 'text/plain', 'x-agent-team-filename': 'a.txt' },
    body: 'x',
  });
  assert.equal(crossOrigin.status, 403);

  // 同源 Origin 正常放行。
  const sameOrigin = await rawRequest(target, '/api/panel-agent/attachments', {
    method: 'POST',
    headers: { origin: `http://127.0.0.1:${target.port}`, 'content-type': 'text/plain', 'x-agent-team-filename': 'a.txt' },
    body: 'x',
  });
  assert.equal(sameOrigin.status, 201);
});

test('upload without a panel agent returns 404', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'attachment-http-empty-'));
  const server = await startServer({ directory, hosts: new Map() });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const response = await upload(server.url, Buffer.from('x'));
  assert.equal(response.status, 404);
});
