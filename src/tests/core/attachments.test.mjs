import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serverScenario, seedPanelAgent } from '../support/fixture.mjs';
import * as panelAgg from '../../aggregates/panel.mjs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { request as httpRequest } from 'node:http';
import { startServer } from '../../server.mjs';

describe('attachments', () => {
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function setup(t) {
  const { server, bus, directory, url } = await serverScenario(t);
  const agentId = seedPanelAgent(bus);
  return { server, bus, agentId, directory, url };
}

function textBuffer(content = '你好\nworld') {
  return Buffer.from(content, 'utf8');
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

function attachmentsRoot(directory) {
  return join(directory, 'attachments');
}

function insertPanelMessage(bus, agentId) {
  const messageId = randomUUID();
  bus.store.run(
    'INSERT INTO panel_messages(id,panel_agent_id,context,role,text,active_team_id,created) VALUES(?,?,?,?,?,?,?)',
    messageId, agentId, 'private', 'user', '看附件', null, new Date().toISOString(),
  );
  return messageId;
}

function ageAttachment(bus, id, hours) {
  bus.store.run('UPDATE attachments SET created_at=? WHERE id=?', new Date(Date.now() - hours * 3600 * 1000).toISOString(), id);
}

test('upload stores UUID copy with metadata, permissions and no .part leftover', async t => {
  const { bus, agentId, directory } = await setup(t);
  const uploaded = await bus.attachmentUpload(agentId, textBuffer(), { name: '笔记.txt' });
  assert.match(uploaded.id, UUID_RE);
  assert.equal(uploaded.name, '笔记.txt');
  assert.equal(uploaded.mediaType, 'text/plain');
  assert.equal(uploaded.size, Buffer.byteLength('你好\nworld'));

  const row = bus.store.get('SELECT * FROM attachments WHERE id=?', uploaded.id);
  assert.ok(row, '应插入附件记录');
  assert.match(row.storage_name, UUID_RE);
  assert.equal(row.original_name, '笔记.txt');
  assert.equal(row.panel_message_id, null);
  assert.equal(row.ordinal, null);

  // 存储名是 UUID;磁盘上不出现原始文件名;没有 .part 残留。
  const files = readdirSync(attachmentsRoot(directory));
  assert.deepEqual(files, [row.storage_name]);
  const fileStat = statSync(join(attachmentsRoot(directory), row.storage_name));
  // Windows 不表达 POSIX 权限位(chmod 只切只读),0600/0700 只在 POSIX 平台可断言。
  if (process.platform !== 'win32') {
    assert.equal(fileStat.mode & 0o777, 0o600, '附件文件应为 0600');
    assert.equal(statSync(attachmentsRoot(directory)).mode & 0o777, 0o700, '附件目录应为 0700');
  }

  // read 返回元数据与原始字节流,不暴露路径。
  const read = bus.attachmentRead(agentId, uploaded.id);
  assert.equal(read.name, '笔记.txt');
  assert.equal(read.mediaType, 'text/plain');
  const chunks = [];
  for await (const chunk of read.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), '你好\nworld');
});

test('same-name uploads never overwrite: distinct ids and physical files', async t => {
  const { bus, agentId, directory } = await setup(t);
  const first = await bus.attachmentUpload(agentId, textBuffer('one'), { name: 'a.txt' });
  const second = await bus.attachmentUpload(agentId, textBuffer('two'), { name: 'a.txt' });
  assert.notEqual(first.id, second.id);
  const rows = bus.store.all('SELECT id,storage_name FROM attachments ORDER BY size');
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map(row => row.storage_name)).size, 2, '物理文件按 UUID 区分');
  assert.deepEqual(readdirSync(attachmentsRoot(directory)).sort(), rows.map(row => row.storage_name).sort());
});

test('upload enforces size limit and aborts the stream without leaving parts', async t => {
  const { bus, agentId, directory } = await setup(t);
  bus.updateAttachmentSettings({ maxFileBytes: 16, maxFilesPerMessage: 4, maxImagePixels: 20_000_000 });
  await assert.rejects(
    () => bus.attachmentUpload(agentId, textBuffer('x'.repeat(64)), { name: 'big.txt' }),
    error => error.code === 'payload_too_large',
  );
  assert.equal(readdirSync(attachmentsRoot(directory)).length, 0, '超限后不残留临时文件');
  assert.equal(panelAgg.attachmentsForAgent(bus.store, agentId).length, 0);

  // 恰好在限额内的内容正常保存。
  const ok = await bus.attachmentUpload(agentId, textBuffer('x'.repeat(10)), { name: 'ok.txt' });
  assert.equal(ok.size, 10);
});

test('upload rejects non-UTF-8 text, NUL and binary control characters', async t => {
  const { bus, agentId } = await setup(t);
  await assert.rejects(
    () => bus.attachmentUpload(agentId, Buffer.from([0xff, 0xfe, 0x68, 0x69]), { name: 'bad.txt' }),
    error => error.code === 'invalid_content',
  );
  await assert.rejects(
    () => bus.attachmentUpload(agentId, textBuffer('a\0b'), { name: 'nul.txt' }),
    error => error.code === 'invalid_content',
  );
  await assert.rejects(
    () => bus.attachmentUpload(agentId, textBuffer('a\x01b'), { name: 'ctrl.txt' }),
    error => error.code === 'invalid_content',
  );
  // \t \n \r 是合法文本。
  const ok = await bus.attachmentUpload(agentId, textBuffer('a\tb\nc\r\nd'), { name: 'ok.txt' });
  assert.ok(ok.id);
});

test('upload rejects broken, truncated and non-PNG images', async t => {
  const { bus, agentId } = await setup(t);
  const png = pngBuffer();

  // 非 PNG 字节但声明 image/png:签名拒绝。
  await assert.rejects(
    () => bus.attachmentUpload(agentId, Buffer.from('not a png at all'), { name: 'fake.png' }),
    error => error.code === 'invalid_content',
  );

  // 内容损坏:尾部字节翻转后无法完整解码。
  const corrupted = Buffer.from(png);
  corrupted[corrupted.length - 10] ^= 0xff;
  await assert.rejects(
    () => bus.attachmentUpload(agentId, corrupted, { name: 'broken.png' }),
    error => error.code === 'invalid_content',
  );

  // 截断的 PNG。
  await assert.rejects(
    () => bus.attachmentUpload(agentId, png.subarray(0, 20), { name: 'trunc.png' }),
    error => error.code === 'invalid_content',
  );

  const ok = await bus.attachmentUpload(agentId, png, { name: 'ok.png' });
  assert.ok(ok.id);
});

test('upload accepts valid JPEG and rejects broken or truncated ones', async t => {
  const { bus, agentId } = await setup(t);
  const ok = await bus.attachmentUpload(agentId, jpegBuffer(), { name: 'photo.jpg' });
  assert.equal(ok.mediaType, 'image/jpeg');
  assert.ok(ok.id);

  // 非 JPEG 字节但扩展名 .jpg:签名拒绝。
  await assert.rejects(
    () => bus.attachmentUpload(agentId, Buffer.from('not a jpeg'), { name: 'fake.jpg' }),
    error => error.code === 'invalid_content',
  );

  // 截断的 JPEG。
  const truncated = jpegBuffer();
  await assert.rejects(
    () => bus.attachmentUpload(agentId, truncated.subarray(0, 24), { name: 'trunc.jpg' }),
    error => error.code === 'invalid_content',
  );

  // 内容与扩展名不符:PNG 字节命名为 .jpg → 422。
  await assert.rejects(
    () => bus.attachmentUpload(agentId, pngBuffer(), { name: 'mislabeled.jpg' }),
    error => error.code === 'invalid_content',
  );

  // .jpeg 扩展名同样支持。
  const alt = await bus.attachmentUpload(agentId, jpegBuffer(4, 4), { name: 'alt.jpeg' });
  assert.equal(alt.mediaType, 'image/jpeg');
});

test('upload rejects JPEG above the configured pixel budget', async t => {
  const { bus, agentId } = await setup(t);
  bus.updateAttachmentSettings({ maxFileBytes: 5 * 1024 * 1024, maxFilesPerMessage: 4, maxImagePixels: 100 });
  await assert.rejects(
    () => bus.attachmentUpload(agentId, jpegBuffer(11, 11), { name: 'huge.jpg' }),
    error => error.code === 'invalid_content',
  );
  const ok = await bus.attachmentUpload(agentId, jpegBuffer(10, 10), { name: 'ok.jpg' });
  assert.ok(ok.id);
});

test('upload rejects images above the configured pixel budget', async t => {
  const { bus, agentId } = await setup(t);
  bus.updateAttachmentSettings({ maxFileBytes: 5 * 1024 * 1024, maxFilesPerMessage: 4, maxImagePixels: 100 });
  await assert.rejects(
    () => bus.attachmentUpload(agentId, pngBuffer(11, 11), { name: 'huge.png' }),
    error => error.code === 'invalid_content',
  );
  // 恰好 100 像素允许。
  const ok = await bus.attachmentUpload(agentId, pngBuffer(10, 10), { name: 'ok.png' });
  assert.ok(ok.id);
});

test('upload rejects unsupported extensions and path-like names', async t => {
  const { bus, agentId } = await setup(t);
  for (const name of ['x.pdf', 'x.bin', 'x.gif', 'x.webp', 'x.heic', 'no-extension']) {
    await assert.rejects(
      () => bus.attachmentUpload(agentId, textBuffer(), { name }),
      error => error.code === 'unsupported_media_type',
      `应拒绝: ${name}`,
    );
  }
  // 常见文本扩展与无扩展名文本文件被接受。
  for (const name of ['notes.md', 'data.json', 'config.yaml', 'Makefile', '.gitignore']) {
    const ok = await bus.attachmentUpload(agentId, textBuffer('# 内容'), { name });
    assert.equal(ok.mediaType, 'text/plain');
  }
  for (const name of ['../evil.txt', 'a/b.txt', 'a\\b.txt', 'a\0b.txt', '', '  ']) {
    await assert.rejects(
      () => bus.attachmentUpload(agentId, textBuffer(), { name }),
      error => error.code === 'invalid_request',
      `应拒绝文件名: ${JSON.stringify(name)}`,
    );
  }
});

test('upload works without any workspace and rejects a symlinked storage root', async t => {
  const { bus, agentId, directory } = await setup(t);
  // Panel Agent 完全没有私人工作区:附件照常上传,存数据目录。
  const ok = await bus.attachmentUpload(agentId, textBuffer(), { name: 'a.txt' });
  assert.ok(ok.id);
  assert.ok(readdirSync(attachmentsRoot(directory)).includes(ok.id));

  // 把存储根换成指向外部的符号链接:拒绝使用,防止附件字节被引出受控目录。
  try { rmSync(attachmentsRoot(directory), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  bus.store.run("DELETE FROM attachments WHERE id=?", ok.id);
  const outside = mkdtempSync(join(tmpdir(), 'attachments-outside-'));
  t.after(() => { try { rmSync(outside, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  symlinkSync(outside, attachmentsRoot(directory), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    () => bus.attachmentUpload(agentId, textBuffer(), { name: 'a.txt' }),
    error => error.code === 'storage_unavailable',
  );
});

test('discard removes unsent rows and files; bound or missing attachments are not_found', async t => {
  const { bus, agentId, directory } = await setup(t);
  const uploaded = await bus.attachmentUpload(agentId, textBuffer(), { name: 'a.txt' });
  assert.deepEqual(bus.attachmentDiscard(agentId, uploaded.id), { discarded: uploaded.id });
  assert.equal(readdirSync(attachmentsRoot(directory)).length, 0);
  assert.throws(() => bus.attachmentDiscard(agentId, uploaded.id), error => error.code === 'not_found');

  // 已绑定附件不能 discard;不存在的 ID 也统一 not_found。
  const bound = await bus.attachmentUpload(agentId, textBuffer(), { name: 'b.txt' });
  const messageId = insertPanelMessage(bus, agentId);
  bus.store.transaction(() => bus.attachments.bindTx(agentId, messageId, [bound.id]));
  assert.throws(() => bus.attachmentDiscard(agentId, bound.id), error => error.code === 'not_found');
  assert.throws(() => bus.attachmentDiscard(agentId, randomUUID()), error => error.code === 'not_found');
});

test('describeMessage reports availability from the file system without hiding records', async t => {
  const { bus, agentId, directory } = await setup(t);
  const first = await bus.attachmentUpload(agentId, textBuffer('first'), { name: '1.txt' });
  const second = await bus.attachmentUpload(agentId, textBuffer('second'), { name: '2.txt' });
  const messageId = insertPanelMessage(bus, agentId);
  bus.store.transaction(() => bus.attachments.bindTx(agentId, messageId, [first.id, second.id]));

  const described = bus.attachmentDescribeMessage(agentId, messageId);
  assert.deepEqual(described.map(row => row.id), [first.id, second.id], '按绑定顺序返回');
  assert.ok(described.every(row => row.availability === 'available'));
  assert.deepEqual(Object.keys(described[0]).sort(), ['availability', 'id', 'mediaType', 'name', 'size'], 'DTO 不含路径或存储名');

  // 文件缺失:记录保留,availability=missing。
  const storageName = bus.store.get('SELECT storage_name FROM attachments WHERE id=?', second.id).storage_name;
  unlinkSync(join(attachmentsRoot(directory), storageName));
  const afterLoss = bus.attachmentDescribeMessage(agentId, messageId);
  assert.equal(afterLoss.find(row => row.id === second.id).availability, 'missing');
  assert.equal(afterLoss.find(row => row.id === first.id).availability, 'available');
});

test('prepare resolves ordered host inputs and fails clearly on missing files', async t => {
  const { bus, agentId, directory } = await setup(t);
  const first = await bus.attachmentUpload(agentId, textBuffer('first'), { name: '1.txt' });
  const second = await bus.attachmentUpload(agentId, pngBuffer(), { name: '2.png' });

  const prepared = bus.attachmentPrepare(agentId, [first.id, second.id]);
  assert.deepEqual(prepared.map(row => row.id), [first.id, second.id], '宿主输入保留用户顺序');
  assert.deepEqual(prepared.map(row => row.mediaType), ['text/plain', 'image/png']);
  assert.ok(prepared.every(row => row.path.startsWith(attachmentsRoot(directory))), '路径仅限受控目录');
  assert.ok(prepared.every(row => row.path.endsWith(row.id)), '存储路径只使用 UUID 文件名');

  const storageName = bus.store.get('SELECT storage_name FROM attachments WHERE id=?', second.id).storage_name;
  unlinkSync(join(attachmentsRoot(directory), storageName));
  assert.throws(
    () => bus.attachmentPrepare(agentId, [first.id, second.id]),
    error => error.code === 'attachment_missing',
  );
});

test('cleanup removes expired unsent copies but keeps fresh and bound records', async t => {
  const { bus, agentId, directory } = await setup(t);
  const fresh = await bus.attachmentUpload(agentId, textBuffer('fresh'), { name: 'fresh.txt' });
  const expired = await bus.attachmentUpload(agentId, textBuffer('expired'), { name: 'old.txt' });
  const bound = await bus.attachmentUpload(agentId, textBuffer('bound'), { name: 'bound.txt' });

  const messageId = insertPanelMessage(bus, agentId);
  bus.store.transaction(() => bus.attachments.bindTx(agentId, messageId, [bound.id]));
  // 两个未发送附件伪造为 25 小时前上传;其中一个随后被绑定。
  ageAttachment(bus, expired.id, 25);
  ageAttachment(bus, bound.id, 25);

  const removed = bus.attachmentCleanup(new Date());
  assert.equal(removed.records, 1);
  const remaining = bus.store.all('SELECT id FROM attachments').map(row => row.id);
  assert.ok(remaining.includes(fresh.id), '未过期不清理');
  assert.ok(remaining.includes(bound.id), '已绑定不清理');
  assert.ok(!remaining.includes(expired.id), '过期未发送清理');
  assert.equal(readdirSync(attachmentsRoot(directory)).length, 2, '文件与记录同步清理');
});

test('bind and cleanup serialize: a cleaned attachment cannot be sent, a bound one cannot be cleaned', async t => {
  const { bus, agentId } = await setup(t);
  const messageId = insertPanelMessage(bus, agentId);

  // 先绑定(新鲜时),再把 created_at 伪造为过期:已绑定记录清理不能动它。
  const winner = await bus.attachmentUpload(agentId, textBuffer('winner'), { name: 'w.txt' });
  bus.store.transaction(() => bus.attachments.bindTx(agentId, messageId, [winner.id]));
  ageAttachment(bus, winner.id, 25);
  bus.attachmentCleanup(new Date());
  const stillReadable = bus.attachmentRead(agentId, winner.id);
  assert.equal(stillReadable.name, 'w.txt', '已绑定记录不被清理');
  // 读完再进入下一步：既证明文件内容还在，也保证 fd 已释放。
  // 只 destroy() 不等 close 的话，open 还在队列里，测试结束删临时目录会撞成 ENOENT。
  const chunks = [];
  for await (const chunk of stillReadable.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'winner', '已绑定附件仍可读取');

  // 先清理后绑定:不能发送一个已经被清理的附件。
  const loser = await bus.attachmentUpload(agentId, textBuffer('loser'), { name: 'l.txt' });
  ageAttachment(bus, loser.id, 25);
  bus.attachmentCleanup(new Date());
  assert.throws(
    () => bus.store.transaction(() => bus.attachments.bindTx(agentId, messageId, [loser.id])),
    error => error.code === 'not_found',
  );
});

test('bind validates ownership, duplicates and expiry inside the transaction', async t => {
  const { bus, agentId } = await setup(t);
  const uploaded = await bus.attachmentUpload(agentId, textBuffer(), { name: 'a.txt' });
  const messageId = insertPanelMessage(bus, agentId);

  assert.throws(() => bus.store.transaction(() => bus.attachments.bindTx(agentId, messageId, [])), error => error.code === 'invalid_request');
  assert.throws(() => bus.store.transaction(() => bus.attachments.bindTx(agentId, messageId, [uploaded.id, uploaded.id])), error => error.code === 'invalid_request');
  assert.throws(() => bus.store.transaction(() => bus.attachments.bindTx(agentId, messageId, [randomUUID()])), error => error.code === 'not_found');
  // 跨 agent 的附件 ID 一律视为不存在。
  assert.throws(() => bus.store.transaction(() => bus.attachments.bindTx(randomUUID(), messageId, [uploaded.id])), error => error.code === 'not_found');
  // 过期附件不能绑定。
  ageAttachment(bus, uploaded.id, 25);
  assert.throws(() => bus.store.transaction(() => bus.attachments.bindTx(agentId, messageId, [uploaded.id])), error => error.code === 'conflict');
  // 失败绑定后附件仍是未发送草稿：公共 discard 只删 panel_message_id IS NULL 的行。
  assert.deepEqual(bus.attachmentDiscard(agentId, uploaded.id), { discarded: uploaded.id }, '失败的绑定不留半套关联');
});

test('startup-style part sweep removes stale temp files and keeps fresh ones on periodic runs', async t => {
  const { bus, agentId, directory } = await setup(t);
  // seed 上传创建附件根目录;此后的 .part 均为模拟崩溃遗留。
  const seed = await bus.attachmentUpload(agentId, textBuffer('seed'), { name: 'seed.txt' });
  const root = attachmentsRoot(directory);
  const stale = join(root, `${randomUUID()}.part`);
  const fresh = join(root, `${randomUUID()}.part`);
  writeFileSync(stale, 'partial');
  writeFileSync(fresh, 'partial');
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(stale, old, old);

  bus.attachmentCleanup(new Date(), { partMaxAgeMs: 0 });
  assert.deepEqual(readdirSync(root), [seed.id], '启动清理移除全部 .part,只留下已记录附件');

  writeFileSync(fresh, 'partial');
  bus.attachmentCleanup(new Date());
  assert.deepEqual(readdirSync(root).sort(), [seed.id, basename(fresh)].sort(), '周期清理保留新鲜 .part');
});

test('upload failure cleans up: disk write failure and db insert failure leave nothing behind', async t => {
  const { bus, agentId, directory } = await setup(t);
  const root = attachmentsRoot(directory);
  const seed = await bus.attachmentUpload(agentId, textBuffer('seed'), { name: 'seed.txt' });

  // 写盘失败:附件根目录位置被同名文件占据,mkdir 必然失败,上传不留记录。
  // 不用 chmod 只读:Windows 的 chmod 只切只读属性,不阻止新建文件。
  const parked = `${root}.parked`;
  renameSync(root, parked);
  writeFileSync(root, 'not a directory');
  try {
    await assert.rejects(
      () => bus.attachmentUpload(agentId, textBuffer('no room'), { name: 'nope.txt' }),
    );
  } finally {
    unlinkSync(root);
    renameSync(parked, root);
  }
  assert.equal(panelAgg.attachmentsForAgent(bus.store, agentId).filter(row => row.original_name === 'nope.txt').length, 0);

  // DB 插入失败:rename 后的最终文件必须被删除,不产生无记录孤儿。
  bus.store.db.exec('DROP TABLE attachments');
  await assert.rejects(
    () => bus.attachmentUpload(agentId, textBuffer('db fail'), { name: 'dbfail.txt' }),
  );
  assert.deepEqual(readdirSync(root), [seed.id], '只剩此前的 seed 文件');
});


test('upload accepts the exact .env filename from the text allowlist', async t => {
  const { bus, agentId } = await setup(t);
  const uploaded = await bus.attachmentUpload(agentId, textBuffer('EXAMPLE=value\n'), { name: '.env' });
  assert.equal(uploaded.name, '.env');
  assert.equal(uploaded.mediaType, 'text/plain');
});
});

describe('attachment-http', () => {
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
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const response = await upload(server.url, Buffer.from('x'));
  assert.equal(response.status, 404);
});
});

describe('attachment-settings', () => {
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
});

test('attachment settings persist across restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'attachment-settings-'));
  // 两个 server 复用同一目录:teardown 必须只关闭"当前"server 再删目录。
  // 若沿用 setup() 的 teardown,它会在第二个 server 仍持有数据库文件时删除
  // 目录(Windows 报 EPERM),且失败后第二个 server 泄漏、事件循环永不排空。
  let server = await startServer({ directory, hosts: new Map() });
  t.after(async () => {
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
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
});
