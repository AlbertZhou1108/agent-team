// Manual integration probe: real DSH, isolated Bus, localhost-only upload shim.
// Does not add a production attachment API. Requires existing DSH login.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { startServer, socketFor } from '../../src/server.mjs';
import { createDshHost } from '../../src/hosts/cli-hosts.mjs';

const root = mkdtempSync(join(tmpdir(), 'attachment-dsh-vertical-'));
const directory = join(root, 'data'), workspace = join(root, 'workspace');
mkdirSync(workspace, { recursive: true });
const attachments = join(workspace, 'attachments');
mkdirSync(attachments);
const log = (value) => { writeFileSync(join(root, 'results.jsonl'), JSON.stringify(value) + '\n', { flag: 'a' }); console.log(JSON.stringify(value)); };
const words = [randomBytes(9).toString('hex'), randomBytes(9).toString('hex')];
const expected = { words, ...JSON.parse(readFileSync(new URL('./fixtures/dsh-grid.expected.json', import.meta.url), 'utf8')) };
writeFileSync(join(root, 'expected.json'), JSON.stringify(expected));
let service, lastContext, events = [];
function realHost() {
  const host = createDshHost({ directory, socketPath: socketFor(directory) });
  const run = host.run.bind(host);
  host.run = async context => {
    lastContext = context;
    return run({ ...context, onEvent: row => {
      if (['tool_call', 'tool_result', 'framework.model.selection', 'final'].includes(row.type)) events.push(row);
      context.onEvent?.(row);
    } });
  };
  return host;
}
async function boot() { service = await startServer({ directory, hosts: new Map([['dsh', realHost()]]) }); }
async function turn(name, prompt) {
  events = [];
  const timer = setTimeout(() => { void service.bus.stopPanel(); }, 75000);
  try {
    const response = await fetch(new URL('/api/panel-agent/messages', service.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: prompt }), signal: AbortSignal.timeout(85000) });
    const result = await response.json();
    const evidence = { case: name, status: response.status, result: result.result ?? result.error ?? result.reply?.text, events };
    log(evidence); return evidence;
  } finally { clearTimeout(timer); }
}
const gateway = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/upload') { response.writeHead(404).end(); return; }
    const buffers = []; let size = 0;
    for await (const b of request) { size += b.length; if (size > 1024 * 1024) throw new Error('probe upload too large'); buffers.push(b); }
    const body = Buffer.concat(buffers), extension = request.headers['x-probe-type'] === 'png' ? '.png' : '.txt';
    const path = join(attachments, randomUUID() + extension);
    writeFileSync(path, body, { mode: 0o600 });
    response.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }));
  } catch (error) { response.writeHead(400).end(error.message); }
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${gateway.address().port}`;
async function upload(bytes, type) {
  const response = await fetch(origin + '/upload', { method: 'POST', headers: { 'x-probe-type': type }, body: bytes });
  if (response.status !== 201) throw new Error('upload failed');
  return response.json();
}
try {
  log({ root, kind: 'probe-start', nativeUploadApi: false });
  await boot();
  const catalog = await service.bus.modelCatalog({ refresh: true });
  const models = catalog.hosts.find(h => h.host === 'dsh')?.catalog?.models;
  const model = models?.find(m => m.id === 'deepseek-flash' && m.provider === 'deepseek-official');
  if (!model) throw new Error('required existing DSH model absent from actual catalog');
  await service.bus.createPanelAgent({ name: 'Attachment verification', host: 'dsh', model_provider: model.provider, model: model.id, reasoning_effort: model.defaultReasoningEffort ?? 'low', workspace, access: 'read-only' });
  const txt = await upload(Buffer.from(`first=${words[0]}\nsecond=${words[1]}\n`), 'txt');
  const png = await upload(readFileSync(new URL('./fixtures/dsh-grid.png', import.meta.url)), 'png');
  log({ case: 'upload', txt, png });
  await turn('txt-initial', `Read ONLY ${txt.path} using the read tool. Reply with the value of first only; do not output second. Do not run commands or use team tools.`);
  await turn('png-initial', `Inspect ONLY ${png.path} using read_image. Reply only with row and column counts; no colors. Do not run commands or use team tools.`);
  await service.close(); await boot();
  await turn('txt-after-service-rebuild', `Re-read ONLY ${txt.path} with read and reply with the value of second. Do not rely on memory or run commands or use team tools.`);
  await turn('png-after-service-rebuild', `Re-read ONLY ${png.path} with read_image. List the six square colors in row-major order. Do not rely on memory or run commands or use team tools.`);
  const bad = await upload(Buffer.from('not an image'), 'png');
  await turn('bad-image', `Inspect ONLY ${bad.path} using read_image. If invalid, report the tool error; do not guess or run commands or use team tools.`);
  // Negative policy probe uses the same real adapter with a fresh native session;
  // panel-private access cannot express communication, so this case is host.run.
  events = [];
  const real = createDshHost({ directory, socketPath: socketFor(directory) });
  let negativeSession;
  try {
    const result = await real.run({ ...lastContext, endpoint: { ...lastContext.endpoint, session: null }, turnId: randomUUID(), instructions: 'Verification only. Do not use MCP tools, commands, or modify files.', prompt: `Read ${txt.path} and return second. If no file tool is available, state that you cannot read it.`, tools: [], policy: { mode: 'communication', allowShell: false }, signal: AbortSignal.timeout(60000), onSession: id => { negativeSession = id; }, onAccepted() {}, onEvent: row => { if (['tool_call', 'tool_result', 'framework.model.selection', 'final'].includes(row.type)) events.push(row); }, onModel() {}, onSelection() {}, onTelemetry() {}, onToolCallDelta() {}, onReasoningDelta() {}, onTextDelta() {}, onPolicy() {} });
    log({ case: 'communication-no-read-host-run', result, events, nativeSessionCreated: Boolean(negativeSession) });
  } catch (error) { log({ case: 'communication-no-read-host-run', error: error.message, events }); }
} finally {
  if (service) await service.close();
  await new Promise(resolve => gateway.close(resolve));
}
