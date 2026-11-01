import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.mjs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'attachments-data-'));
  const server = await startServer({ directory, hosts: new Map() });
  const bus = server.bus;
  const agentId = randomUUID();
  const now = new Date().toISOString();
  // workspace 为 NULL 也能上传:附件副本属于框架数据,存数据目录,不依赖私人工作区。
  bus.store.run(
    'INSERT INTO panel_agents(id,singleton,name,host,model_provider,model,reasoning_effort,workspace,access,created,updated) VALUES(?,1,?,?,?,?,?,?,?,?,?)',
    agentId, '测试助手', 'codex', null, 'test-model', null, null, 'read-only', now, now,
  );
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { server, bus, agentId, directory };
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
  assert.equal(bus.store.all('SELECT 1 FROM attachments').length, 0);

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
  rmSync(attachmentsRoot(directory), { recursive: true, force: true });
  bus.store.run("DELETE FROM attachments WHERE id=?", ok.id);
  const outside = mkdtempSync(join(tmpdir(), 'attachments-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, attachmentsRoot(directory));
  await assert.rejects(
    () => bus.attachmentUpload(agentId, textBuffer(), { name: 'a.txt' }),
    error => error.code === 'storage_unavailable',
  );
});

test('discard removes unsent rows and files; bound or missing attachments are not_found', async t => {
  const { bus, agentId, directory } = await setup(t);
  const uploaded = await bus.attachmentUpload(agentId, textBuffer(), { name: 'a.txt' });
  assert.deepEqual(bus.attachmentDiscard(agentId, uploaded.id), { discarded: uploaded.id });
  assert.equal(bus.store.all('SELECT 1 FROM attachments WHERE id=?', uploaded.id).length, 0);
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
  assert.ok(bus.store.get('SELECT 1 FROM attachments WHERE id=?', winner.id), '已绑定记录不被清理');

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
  assert.equal(bus.store.get('SELECT panel_message_id FROM attachments WHERE id=?', uploaded.id).panel_message_id, null, '失败的绑定不留半套关联');
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
  assert.equal(bus.store.all('SELECT 1 FROM attachments WHERE original_name=?', 'nope.txt').length, 0);

  // DB 插入失败:rename 后的最终文件必须被删除,不产生无记录孤儿。
  bus.store.db.exec('DROP TABLE attachments');
  await assert.rejects(
    () => bus.attachmentUpload(agentId, textBuffer('db fail'), { name: 'dbfail.txt' }),
  );
  assert.deepEqual(readdirSync(root), [seed.id], '只剩此前的 seed 文件');
});
