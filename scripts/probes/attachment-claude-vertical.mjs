// Experimental verification gateway only. This does not add a production upload API.
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { startServer, socketFor } from '../../src/server.mjs';
import { createClaudeHost } from '../../src/hosts/cli-hosts.mjs';

const root = mkdtempSync('/tmp/at-claude-vertical-');
console.log(JSON.stringify({ evidence: root }));
const directory = join(root, 'data'), workspace = join(root, 'workspace'), uploads = join(workspace, 'uploads');
mkdirSync(directory); mkdirSync(workspace); mkdirSync(uploads);
const records = [], hostCalls = [], results = [];
let server, gateway, currentCase = 'boot';
const save = () => writeFileSync(join(root, 'evidence.json'), JSON.stringify({ root, records, hostCalls, results }, null, 2));
function observedHost() {
  const host = createClaudeHost({ directory, socketPath: socketFor(directory), reasoningEffort: 'low' });
  const run = host.run.bind(host);
  host.run = context => {
    const call = { case: currentCase, endpoint: context.endpoint.id, sessionBefore: context.endpoint.session, policy: context.policy, workspace: context.workspace, events: [], started: new Date().toISOString() };
    hostCalls.push(call);
    return run({ ...context, onEvent(event) {
      // User test data and tool events only. Do not persist endpoint credentials/configs.
      if (['assistant', 'user', 'result'].includes(event.type)) call.events.push(event);
      if (event.type === 'system' && event.subtype === 'init') call.init = { model: event.model, tools: event.tools, session_id: event.session_id };
      context.onEvent(event);
    } }).then(value => { call.result = value; return value; }).catch(error => { call.error = error.message; throw error; }).finally(() => { call.finished = new Date().toISOString(); save(); });
  };
  return host;
}
async function boot() {
  server = await startServer({ directory, hosts: new Map([['claude', observedHost()]]) });
  records.push({ event: 'server-start', url: server.url, time: new Date().toISOString() });
}
async function request(path, body) {
  const response = await fetch(new URL(path, server.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(95000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}
async function turn(name, prompt) {
  currentCase = name;
  const timer = setTimeout(() => { void server.bus.stopPanel(); }, 90000);
  try {
    const value = await request('/api/panel-agent/messages', { text: prompt });
    const result = { name, reply: value.reply?.text, value, session: server.bus.store.panelSession(server.bus.panelAgent().id, 'private').session };
    results.push(result); save(); console.log(JSON.stringify({ name, reply: result.reply, session: result.session })); return result;
  } finally { clearTimeout(timer); }
}
try {
  await boot();
  const catalog = await server.bus.modelCatalog({ refresh: true });
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(catalog, null, 2));
  const hostCatalog = catalog.hosts.find(row => row.host === 'claude' && row.ok)?.catalog;
  if (!hostCatalog) throw new Error('Real Claude model catalog unavailable');
  const selected = hostCatalog.models.find(row => row.id === hostCatalog.defaultModel) ?? hostCatalog.models.find(row => row.id === 'haiku') ?? hostCatalog.models[0];
  const agent = await request('/api/panel-agent', { name: 'Attachment probe', host: 'claude', model: selected.id, reasoning_effort: 'low', access: 'read-only', workspace });
  records.push({ event: 'agent-created', agent: agent.agent });
  // Probe-only loopback gateway persists uploaded bytes under generated IDs.
  const attachments = new Map();
  gateway = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/probe-upload') { res.writeHead(404); res.end(); return; }
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 1024 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
    const data = Buffer.concat(chunks), kind = req.headers['content-type'];
    if (!['text/plain', 'image/png'].includes(kind)) { res.writeHead(415); res.end(JSON.stringify({ error: 'unsupported probe type' })); return; }
    const id = randomUUID(), file = join(uploads, id + (kind === 'image/png' ? '.png' : '.txt'));
    writeFileSync(file, data, { mode: 0o600 });
    const attachment = { id, path: file, bytes: data.length, mediaType: kind, sha256: createHash('sha256').update(data).digest('hex') };
    attachments.set(id, attachment); records.push({ event: 'upload', ...attachment }); save();
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(attachment));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const uploadUrl = `http://127.0.0.1:${gateway.address().port}/probe-upload`;
  async function upload(data, type) {
    const response = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': type }, body: data });
    if (response.status !== 201) throw new Error(`upload ${response.status}`);
    return response.json();
  }
  const token = randomBytes(16).toString('hex');
  const text = await upload(Buffer.from(`PROBE_TOKEN=${token}\n`), 'text/plain');
  const palette = { red: [220, 25, 40], green: [20, 180, 60], blue: [20, 60, 230], orange: [245, 135, 10] };
  const labels = Array.from(randomBytes(12), n => Object.keys(palette)[n % 4]);
  const width = 640, height = 480, pixels = Buffer.alloc(width * height * 3, 255);
  labels.forEach((label, i) => {
    const row = Math.floor(i / 4), col = i % 4;
    for (let y = 20 + row * 150; y < 130 + row * 150; y++)
      for (let x = 20 + col * 150; x < 130 + col * 150; x++)
        palette[label].forEach((value, k) => { pixels[(y * width + x) * 3 + k] = value; });
  });
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, bytes, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), pixels.subarray(y * width * 3, (y + 1) * width * 3)])));
  const imageBytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const image = await upload(imageBytes, 'image/png');
  writeFileSync(join(root, 'expected.json'), JSON.stringify({ token, labels }));
  await turn('01-uploaded-text', `验证任务：只使用 Read 工具读取这个已上传的测试文件 ${text.path}，只返回 PROBE_TOKEN= 后面的值。不要使用 Bash、网络或修改任何文件，也不要调用其他团队。答案不在问题中，不能猜测。`);
  await turn('02-uploaded-image', `验证任务：只使用 Read 工具读取测试图片 ${image.path}，按从上到下、每行从左到右返回全部色块颜色名称的 JSON 数组，使用 red、green、blue、orange，不要估计十六进制色值。不要使用 Bash、网络或修改文件，不要调用其他团队。`);
  await server.close(); server = null;
  records.push({ event: 'server-closed-for-restart' });
  await boot();
  await turn('03-restart-reread-text', `验证任务：服务已重启。必须重新调用 Read 读取同一测试附件 ${text.path}，只返回 PROBE_TOKEN= 后的值；不要依赖历史答案，不要用 Bash 或其他工具。`);
  await turn('04-restart-reread-image', `验证任务：必须重新调用 Read 读取同一图片附件 ${image.path}，返回全部色块颜色名称的 JSON 数组，使用 red、green、blue、orange，不要估计十六进制色值。不要依赖历史答案，不要用 Bash 或其他工具。`);
  const corrupt = await upload(Buffer.from('THIS_IS_NOT_A_PNG'), 'image/png');
  await turn('05-corrupt-image', `验证任务：只使用 Read 读取这个声称是 PNG 的测试文件 ${corrupt.path}。报告文件是否能作为图片读取；如果失败请如实报告，不要猜图像内容。禁止 Bash 和其他工具。`);
  // A real Panel-led team coordination turn applies communication policy.
  currentCase = '06-communication-policy-no-read';
  const panelAgent = server.bus.panelAgent();
  const group = server.bus.createGroup({ name: 'Attachment communication control', workspace, panelAgentId: panelAgent.id, members: [], policy: 'communication', allowShell: false });
  const coordinationSession = server.bus.store.panelSession(panelAgent.id, 'coordination', group.id);
  const forbiddenToken = randomBytes(16).toString('hex');
  const denied = await upload(Buffer.from(`DENIED_TOKEN=${forbiddenToken}\n`), 'text/plain');
  const timer = setTimeout(() => { void server.bus.stopPanel(); }, 90000);
  try {
    const value = await server.bus.runPanelTurn({ session: { ...coordinationSession, group_id: group.id }, panelAgent, activeTeamId: group.id, prompt: `验证任务：读取测试文件 ${denied.path} 并返回 DENIED_TOKEN= 后的值。如果没有可用文件工具，请明确返回 UNAVAILABLE。不要猜测，不得用 Bash、网络或任何团队工具绕过。` });
    results.push({ name: currentCase, value, deniedToken: forbiddenToken }); save(); console.log(JSON.stringify({ name: currentCase, value }));
  } finally { clearTimeout(timer); }
  const observedRead = name => hostCalls.find(call => call.case === name)?.events.some(event => event.type === 'assistant' && event.message?.content?.some(block => block.type === 'tool_use' && block.name === 'Read'));
  const parseColors = value => { const match = value.match(/\[[\s\S]*\]/); return match ? JSON.parse(match[0]) : null; };
  const checks = {
    textCorrect: results.find(row => row.name === '01-uploaded-text').reply.includes(token),
    textRereadCorrect: results.find(row => row.name === '03-restart-reread-text').reply.includes(token),
    imageCorrect: JSON.stringify(parseColors(results.find(row => row.name === '02-uploaded-image').reply)) === JSON.stringify(labels),
    imageRereadCorrect: JSON.stringify(parseColors(results.find(row => row.name === '04-restart-reread-image').reply)) === JSON.stringify(labels),
    rereadToolsObserved: observedRead('03-restart-reread-text') && observedRead('04-restart-reread-image'),
    communicationDenied: !observedRead('06-communication-policy-no-read') && String(results.at(-1).value).includes('UNAVAILABLE') && !String(results.at(-1).value).includes(forbiddenToken),
    corruptToolError: hostCalls.find(call => call.case === '05-corrupt-image')?.events.some(event => event.type === 'user' && event.message?.content?.some(block => block.type === 'tool_result' && block.is_error)),
    sameSessionAfterRestart: results.find(row => row.name === '01-uploaded-text').session === results.find(row => row.name === '03-restart-reread-text').session,
  };
  writeFileSync(join(root, 'checks.json'), JSON.stringify(checks, null, 2));
  records.push({ event: 'done', checks }); save();
  if (!Object.values(checks).every(Boolean)) throw new Error('A vertical check did not pass');
  console.log(JSON.stringify({ evidence: root }));
} catch (error) { records.push({ event: 'failure', error: error.stack }); save(); console.error(error); process.exitCode = 1; }
finally { if (server) await server.close(); if (gateway) await new Promise(resolve => gateway.close(resolve)); }
