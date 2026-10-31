#!/usr/bin/env node
// 真实宿主纵向验收(生产路径):经生产上传接口、消息接口与真实 Bus/adapter 执行,
// 不复用探针网关;临时数据目录,不影响用户实例。每个宿主覆盖:
// TXT 回读 / PNG 颜色回读 / 两附件同消息顺序 / 重启后重新读取(凭 verify-line 证明非历史回答) /
// 坏 PNG、未知附件、文件缺失 / 附件-only 中途停止。真实模型调用消耗额度,不进入 CI。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { startServer } from '../../src/server.mjs';

const execute = promisify(execFile);
const log = (...args) => console.log(`[acceptance ${new Date().toISOString().slice(11, 19)}]`, ...args);
const PALETTE = {
  red: [255, 0, 0], green: [0, 160, 0], blue: [0, 0, 255],
  yellow: [255, 220, 0], purple: [160, 0, 180], orange: [255, 130, 0],
};

function colorPng(colors) {
  const width = 240, height = 160;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = PALETTE[colors[Math.floor(y / 80) * 2 + Math.floor(x / 120)]];
      const index = (y * width + x) << 2;
      png.data[index] = color[0];
      png.data[index + 1] = color[1];
      png.data[index + 2] = color[2];
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function shuffleColors() {
  return [...Object.keys(PALETTE)]
    .map(color => ({ color, weight: randomBytes(4).readUInt32BE() }))
    .sort((a, b) => a.weight - b.weight)
    .map(item => item.color);
}

function extractColors(text) {
  return String(text).toLowerCase().match(/red|green|blue|yellow|purple|orange/g) ?? [];
}

async function post(base, path, body, timeoutMs = 300000) {
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  return { status: response.status, value };
}

async function uploadRaw(base, bytes, name, mime) {
  const response = await fetch(new URL('/api/panel-agent/attachments', base), {
    method: 'POST',
    headers: {
      'content-type': mime,
      'x-agent-team-filename': encodeURIComponent(name),
      origin: base,
    },
    body: bytes,
  });
  return { status: response.status, value: await response.json().catch(() => null) };
}

function pickModel(catalogHost) {
  const models = catalogHost.catalog.models;
  const cheap = models.find(model => /haiku|flash|mini|lite|nano/i.test(model.id));
  const selected = cheap ?? models.find(model => model.isDefault) ?? models[0];
  return {
    model: selected.id,
    reasoning_effort: selected.defaultReasoningEffort ?? 'low',
    provider: selected.provider ?? null,
  };
}

async function hostVersion(command) {
  try {
    return (await execute(command, ['--version'], { timeout: 15000 })).stdout.trim().split('\n')[0];
  } catch {
    return 'unknown';
  }
}

function replyText(response) {
  return String(response.value?.reply?.text ?? '');
}

async function acceptHost(hostName, command) {
  log(`=== ${hostName} 开始 ===`);
  const root = mkdtempSync(join(tmpdir(), `attach-accept-${hostName}-`));
  const directory = join(root, 'data');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  let server = await startServer({ directory }); // 真实宿主适配器经默认 hosts 配置加载
  let base = server.url.replace(/\/$/, '');
  const record = { host: hostName, hostVersion: await hostVersion(command), checks: {}, startedAt: new Date().toISOString() };
  const check = (name, pass, detail = '') => {
    record.checks[name] = { pass, detail: String(detail).slice(0, 300) };
    log(`${hostName} ${name}: ${pass ? 'PASS' : 'FAIL'} ${detail}`);
    return pass;
  };

  try {
    const catalogPage = await (await fetch(new URL('/api/model-catalog?refresh=1', base))).json();
    const catalogHost = catalogPage.hosts.find(item => item.host === hostName);
    if (!catalogHost?.ok) throw new Error(`${hostName} 宿主不可用: ${catalogHost?.error ?? '无目录'}`);
    const selection = pickModel(catalogHost);
    record.model = selection;
    const created = await post(base, '/api/panel-agent', {
      name: `附件验收-${hostName}`, host: hostName, ...selection, workspace, access: 'read-only',
    });
    if (created.status !== 200) throw new Error(`创建 Panel Agent 失败: ${JSON.stringify(created.value).slice(0, 200)}`);
    log(`${hostName} Panel Agent 就绪 model=${selection.model}`);

    const secret1 = randomBytes(8).toString('hex');
    const secret2 = randomBytes(8).toString('hex');
    const verifyLine = 100000 + randomBytes(4).readUInt32BE() % 900000; // 从未出现在对话里的数字,重启重读的凭据
    const colors1 = shuffleColors();
    const colors2 = shuffleColors();
    const png1 = colorPng(colors1);
    const png2 = colorPng(colors2);
    const txtBytes = Buffer.from(`acceptance secret: ${secret1}\nverify-line: ${verifyLine}\n`, 'utf8');

    // 1) 随机 TXT:上传 → 发送 → 工具读取回随机码
    const txt1 = await uploadRaw(base, txtBytes, 'secret-a.txt', 'text/plain');
    if (!check('uploadTxt', txt1.status === 201, JSON.stringify(txt1.value))) throw new Error('TXT 上传失败');
    const turn1 = await post(base, '/api/panel-agent/messages', {
      text: '验证专用。只用文件读取工具读取附件 secret-a.txt，原样返回其中 acceptance secret: 后面的随机码和 verify-line: 后面的数字，不要做其他任何事。',
      clientMessageId: randomUUID(),
      attachmentIds: [txt1.value.id],
    });
    check('txtRead', turn1.status === 200 && replyText(turn1).includes(secret1) && replyText(turn1).includes(String(verifyLine)),
      replyText(turn1).slice(0, 160));

    // 2) 随机 PNG:按行优先读四色
    const img1 = await uploadRaw(base, png1, 'grid-a.png', 'image/png');
    if (!check('uploadPng', img1.status === 201, JSON.stringify(img1.value))) throw new Error('PNG 上传失败');
    const turn2 = await post(base, '/api/panel-agent/messages', {
      text: '验证专用。读取图片附件 grid-a.png，按行优先顺序（左上、右上、左下、右下）返回四个区域的颜色英文名，不要做其他任何事。',
      clientMessageId: randomUUID(),
      attachmentIds: [img1.value.id],
    });
    const expected1 = colors1.slice(0, 4); // 2x2 网格只用前四色
    check('pngColors', extractColors(replyText(turn2)).join(',') === expected1.join(','),
      `expect=${expected1.join(',')} got=${extractColors(replyText(turn2)).join(',')}`);

    // 3) 两附件同消息:顺序保留 + 历史行结构化附件
    const txt2 = await uploadRaw(base, Buffer.from(`second secret: ${secret2}\n`, 'utf8'), 'secret-b.txt', 'text/plain');
    const img2 = await uploadRaw(base, png2, 'grid-b.png', 'image/png');
    const turn3 = await post(base, '/api/panel-agent/messages', {
      text: `验证专用。先读取图片附件 grid-b.png 返回四个区域颜色（行优先，英文），再读取文本附件 secret-b.txt 返回 second secret: 后的随机码。`,
      clientMessageId: randomUUID(),
      attachmentIds: [img2.value.id, txt2.value.id],
    });
    const expected2 = colors2.slice(0, 4);
    const multiOk = turn3.status === 200
      && replyText(turn3).includes(secret2)
      && extractColors(replyText(turn3)).join(',') === expected2.join(',');
    check('twoAttachments', multiOk, replyText(turn3).slice(0, 200));
    const state = await (await fetch(new URL('/api/panel-agent', base))).json();
    const multiRow = state.conversation.find(row => row.id === turn3.value?.message?.id);
    check('historyAttachments',
      JSON.stringify(multiRow?.attachments?.map(item => item.id) ?? []) === JSON.stringify([img2.value.id, txt2.value.id])
      && multiRow?.attachments?.every(item => item.availability === 'available'),
      JSON.stringify(multiRow?.attachments ?? []));

    // 4) 服务完全重启后重新读取:凭 verify-line 证明不是靠历史回答
    await server.close();
    server = await startServer({ directory });
    base = server.url.replace(/\/$/, '');
    const turn4 = await post(base, '/api/panel-agent/messages', {
      text: '验证专用。请重新用文件读取工具读取本轮之前消息里的附件 secret-a.txt（附件清单在历史输入中），原样返回 acceptance secret: 后的随机码和 verify-line: 后的数字；不要凭对话记忆回答。',
      clientMessageId: randomUUID(),
    });
    check('restartReread', turn4.status === 200 && replyText(turn4).includes(secret1) && replyText(turn4).includes(String(verifyLine)),
      replyText(turn4).slice(0, 160));
    // 重启后历史附件元数据仍在(browser state 只含本次启动窗口,用 history 记录接口核对)
    const records = await (await fetch(new URL('/api/panel-agent/records?history=1', base))).json();
    const rowAfter = (records.messages ?? []).find(row => row.id === turn3.value?.message?.id);
    check('restartHistoryKept', Array.isArray(rowAfter?.attachments) && rowAfter.attachments.length === 2
      && rowAfter.attachments.every(item => item.availability === 'available'),
      JSON.stringify(rowAfter?.attachments ?? []));

    // 5) 失败路径:坏 PNG / 未知附件 / 文件缺失
    const badPng = await uploadRaw(base, Buffer.from('definitely not a png'), 'bad.png', 'image/png');
    check('badPngRejected', badPng.status === 422 && badPng.value?.code === 'invalid_content', JSON.stringify(badPng.value));
    const unknownSend = await post(base, '/api/panel-agent/messages', {
      text: '读取不存在的附件', clientMessageId: randomUUID(), attachmentIds: [randomUUID()],
    });
    check('unknownAttachmentRejected', unknownSend.status === 404 && unknownSend.value?.code === 'not_found', JSON.stringify(unknownSend.value));
    const orphan = await uploadRaw(base, Buffer.from(`orphan secret: ${randomBytes(6).toString('hex')}\n`, 'utf8'), 'orphan.txt', 'text/plain');
    if (!check('orphanUpload', orphan.status === 201 && typeof orphan.value?.id === 'string', JSON.stringify(orphan.value))) throw new Error('orphan 上传失败');
    const storageName = server.bus.store.get('SELECT storage_name FROM attachments WHERE id=?', orphan.value.id)?.storage_name;
    unlinkSync(join(directory, 'attachments', storageName)); // 验收环境内模拟磁盘丢失
    const missingSend = await post(base, '/api/panel-agent/messages', {
      text: '读取附件 orphan.txt 并返回内容', clientMessageId: randomUUID(), attachmentIds: [orphan.value.id],
    });
    // 422 错误响应不含 message 字段;直接查最后一条用户消息(即本次发送)确认没有产生回合。
    const acceptanceAgentId = server.bus.store.get('SELECT id FROM panel_agents LIMIT 1')?.id;
    const lastUserMessage = acceptanceAgentId
      ? server.bus.store.get("SELECT id FROM panel_messages WHERE panel_agent_id=? AND role='user' ORDER BY seq DESC LIMIT 1", acceptanceAgentId)
      : null;
    const missingTurnCount = lastUserMessage
      ? server.bus.store.get("SELECT COUNT(*) AS count FROM panel_turns WHERE source_user_message_id=?", lastUserMessage.id)?.count ?? -1
      : -1;
    check('missingFileRejected', missingSend.status === 422 && missingSend.value?.code === 'attachment_missing' && missingTurnCount === 0,
      `status=${missingSend.status} code=${missingSend.value?.code} turns=${missingTurnCount}`);

    // 6) 附件-only 中途停止:消息与附件不被静默删除
    const png3 = colorPng(shuffleColors());
    const img3 = await uploadRaw(base, png3, 'grid-c.png', 'image/png');
    const pending = post(base, '/api/panel-agent/messages', {
      text: '', clientMessageId: randomUUID(), attachmentIds: [img3.value.id],
    }).catch(error => ({ status: 0, value: String(error) }));
    await new Promise(resolve => setTimeout(resolve, 2500));
    const stop = await post(base, '/api/panel-agent/stop', {});
    const stopResult = await pending;
    await new Promise(resolve => setTimeout(resolve, 1500));
    const stopState = await (await fetch(new URL('/api/panel-agent', base))).json();
    const stopRow = stopState.conversation.filter(row => row.role === 'user').at(-1);
    const stopTurn = server.bus.store.get('SELECT state FROM panel_turns ORDER BY created DESC LIMIT 1');
    const intact = Boolean(stopRow?.id)
      && Array.isArray(stopRow?.attachments) && stopRow.attachments.length === 1
      && stopRow.attachments[0].availability === 'available'
      && stopTurn && stopTurn.state !== 'running';
    check('stopKeepsMessageAndAttachment', intact,
      `stop=${stop.status}/${JSON.stringify(stop.value)} send=${stopResult.status} turn=${stopTurn?.state} row=${Boolean(stopRow?.attachments?.length)}`);

    const passCount = Object.values(record.checks).filter(item => item.pass).length;
    record.allPassed = passCount === Object.keys(record.checks).length;
    log(`=== ${hostName} 结束: ${passCount}/${Object.keys(record.checks).length} 通过 ===`);
    return record;
  } catch (error) {
    record.fatal = String(error?.stack ?? error).slice(0, 600);
    log(`${hostName} FATAL: ${record.fatal}`);
    return record;
  } finally {
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

const hosts = [
  { name: 'dsh', command: 'dsh' },
  { name: 'codex', command: 'codex' },
  { name: 'claude', command: 'claude' },
];
const records = [];
for (const host of hosts) {
  records.push(await acceptHost(host.name, host.command));
}
const summary = {
  generatedAt: new Date().toISOString(),
  hosts: records,
  allPassed: records.every(record => record.allPassed),
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.allPassed ? 0 : 1;
