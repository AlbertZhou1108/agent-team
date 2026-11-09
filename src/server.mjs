import { version } from './version.mjs';
import { matchRoute } from './http/access.mjs';
import { apiRoutes } from './http/routes.mjs';
import net from 'node:net';
import { observeResponsiveness } from './responsiveness.mjs';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, readFileSync, unlinkSync, chmodSync, lstatSync, closeSync, existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bus } from './bus.mjs';
import { rpc } from './rpc.mjs';
import { HOST_FACTORIES, DEFAULT_HOST_SPECS, assertHostContract } from './hosts/index.mjs';

export function socketFor(directory) {
  if (process.platform === 'win32') {
    const key = createHash('sha256').update(resolve(directory).toLowerCase()).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\agent-team-${key}`;
  }
  const candidate = resolve(directory, 'bus.sock');
  return Buffer.byteLength(candidate) < 100 ? candidate : `/tmp/agent-team-${process.getuid?.() ?? 'local'}-${createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 20)}.sock`;
}
export async function loadHosts({ directory, socketPath, configFile }) {
  socketPath ??= socketFor(directory);
  const specs = configFile ? JSON.parse(readFileSync(resolve(configFile), 'utf8')).hosts : DEFAULT_HOST_SPECS;
  if (!specs || typeof specs !== 'object' || Array.isArray(specs)) throw new Error('宿主配置需要 hosts 对象');
  const hosts = new Map();
  for (const [name, spec] of Object.entries(specs)) {
    const factory = spec.module ? (await import(pathToFileURL(resolve(spec.module)).href)).createHost : HOST_FACTORIES.get(spec.adapter);
    if (typeof factory !== 'function') throw new Error(`未配置宿主适配器: ${name}`);
    const host = await factory({ directory, socketPath, ...spec });
    assertHostContract(name, host);
    hosts.set(name, host);
  }
  return hosts;
}

export async function startServer({ directory, port = 0, hosts, configFile }) {
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const socketPath = socketFor(directory), lockPath = resolve(directory, 'owner.json');
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(readFileSync(lockPath, 'utf8')); }
    catch (error) { throw new Error('无法判断数据目录所有者；请先检查 owner.json', { cause: error }); }
    // 此处无被捕获的 error 对象可作 cause;规则建议注入的 error 在该作用域不存在。
    // eslint-disable-next-line preserve-caught-error
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('数据目录锁格式无效');
    // eslint-disable-next-line preserve-caught-error -- 原始冲突信号由外层 catch 原样重抛,无需 cause
    try { process.kill(owner.pid, 0); throw new Error('该数据目录已有群总线运行'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    unlinkSync(lockPath);
    lock = openSync(lockPath, 'wx', 0o600);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid })); closeSync(lock);
  const instanceId = randomUUID();
  let serviceUrl;
  let bus, ipc, panel, diagnostics, socketOwned = false;
  const panelEventStreams = new Set();
  const close = async () => {
    diagnostics?.close();
    if (bus && !bus.closing) await bus.close();
    for (const response of panelEventStreams) response.end();
    panelEventStreams.clear();
    await Promise.all([ipc, panel].filter(Boolean).map(server => new Promise(resolve => { if (server.listening) server.close(resolve); else resolve(); })));
    if (socketOwned && process.platform !== 'win32') { try { unlinkSync(socketPath); } catch { /* net.Server may have removed it. */ } }
    try { if (JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid) unlinkSync(lockPath); } catch { /* Already cleaned up. */ }
  };
  try {
    try {
      if (process.platform === 'win32') {
        // Named pipes are managed by Windows and have no filesystem entry.
      } else if (lstatSync(socketPath).isSocket()) {
        try { await rpc(socketPath, { op: 'ping' }, 1500); throw new Error('已有群总线使用此 socket'); }
        catch (error) { if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error; }
        unlinkSync(socketPath);
      } else throw new Error('socket 路径被其他文件占用');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    bus = new Bus({
      directory,
      hosts: hosts ?? await loadHosts({ directory, socketPath, configFile }),
      controlSocketPath: socketPath,
    });
    ipc = net.createServer(socket => {
      socket.setEncoding('utf8');
      let receivedBytes = 0;
      let data = '', handled = false;
      socket.setTimeout(960000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', async chunk => {
        if (handled) return;
        receivedBytes += Buffer.byteLength(chunk, 'utf8');
        data += chunk;
        if (receivedBytes > 1024 * 1024) return socket.destroy();
        if (!data.includes('\n')) return;
        handled = true;
        try {
          const request = JSON.parse(data.split('\n')[0]);
          if (request.op === 'instance') {
            if (!serviceUrl) throw new Error('服务尚未就绪');
            socket.end(JSON.stringify({ result: { instanceId, pid: process.pid, directory, url: serviceUrl, version } }) + '\n');
          } else if (request.op === 'service_stop') {
            if (request.instanceId !== instanceId) throw new Error('服务实例已变更');
            socket.end(JSON.stringify({ result: { stopped: true } }) + '\n');
            socket.once('close', () => { void close(); });
          } else { const value = await handleRpc(bus, request); socket.end(JSON.stringify({ result: value }) + '\n'); }
        }
        catch (error) {
          socket.end(JSON.stringify({
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
            ...(error.details ? { details: error.details } : {}),
          }) + '\n');
        }
      });
    });
    await new Promise((resolve, reject) => { ipc.once('error', reject); ipc.listen(socketPath, resolve); });
    socketOwned = true;
    if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
    diagnostics = observeResponsiveness(directory);
    panel = http.createServer(async (request, response) => {
      diagnostics.request(request, response);
      const fail = (status, text) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(text); };
      const failJson = (status, error) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      };
      try {
        const actualPort = panel.address().port;
        if (request.headers.host !== `127.0.0.1:${actualPort}` && request.headers.host !== `localhost:${actualPort}`) return fail(403, 'Invalid host');
        const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
        if (request.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'Cross-site request rejected');
        const route = matchRoute(apiRoutes({ bus, url, request, fail, failJson, readJsonBody, cursor, response, panelEventStreams, serviceInfo: () => ({ version, directory, url: serviceUrl }), stopService: () => { void close(); } }), request.method, url);
        const teamStateMutation = route?.archived === true;
        if (request.method !== 'GET' && !route) return fail(403, 'Panel endpoint is not writable');
        if (request.method !== 'GET' && request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return fail(403, 'Cross-origin request rejected');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        const requestedTeam = url.searchParams.get('group') || url.pathname.match(/^\/api\/teams\/([^/]+)/)?.[1];
        const endpointId = url.searchParams.get('endpoint');
        const endpointTeam = endpointId ? bus.store.get('SELECT group_id FROM conversations WHERE id=?', endpointId)?.group_id : null;
        const messageTeam = url.searchParams.get('message') ? bus.store.get('SELECT group_id FROM messages WHERE id=?', url.searchParams.get('message'))?.group_id : null;
        const interactionId = url.pathname.match(/^\/api\/interactions\/([^/]+)\/answer$/)?.[1];
        const interactionTeam = interactionId ? bus.store.get('SELECT group_id FROM interactions WHERE id=?', interactionId)?.group_id : null;
        const turnId = url.searchParams.get('turn');
        const turnTeam = turnId ? bus.store.get('SELECT c.group_id FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=?', turnId)?.group_id : null;
        for (const id of [requestedTeam, endpointTeam, messageTeam, interactionTeam, turnTeam]) {
          if (id && bus.store.get('SELECT state FROM groups WHERE id=?', id)?.state === 'archived' && !teamStateMutation) return fail(410, '团队已归档，请在设置中恢复后访问');
        }


        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          if (!route) return fail(404, 'Not found');
          let value;
          const result = await route.handle();
          if (response.headersSent) return;
          value = result;
          if (['/api/overview', '/api/snapshot', '/api/directory'].includes(url.pathname)) {
            const activeIds = new Set(bus.store.all("SELECT id FROM groups WHERE state IS NULL OR state!='archived'").map(row => row.id));
            for (const key of ['groups', 'groupStates', 'panelTeams']) if (Array.isArray(value[key])) value[key] = value[key].filter(row => activeIds.has(row.id));
            for (const key of ['members', 'endpoints', 'agentTasks']) if (Array.isArray(value[key])) value[key] = value[key].filter(row => activeIds.has(row.group_id));
            if (value.endpoints) { const ids = new Set(value.endpoints.map(row => row.id)); value.sessionBindings = value.sessionBindings.filter(row => ids.has(row.endpoint_id)); value.runningEndpoints = value.runningEndpoints.filter(id => ids.has(id)); }
          }
          response.writeHead(200, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify(value));
        }
        const staticFile = resolvePanelFile(url.pathname, request.headers.accept);
        if (!staticFile) return fail(404, 'Not found');
        if (!existsSync(staticFile.path)) return staticFile.type === 'text/html'
          ? fail(503, '面板尚未构建，请运行 npm run build')
          : fail(404, 'Not found');
        response.writeHead(200, { 'Content-Type': `${staticFile.type}; charset=utf-8` }); response.end(readFileSync(staticFile.path));
      } catch (error) { fail(400, error.message); }
    });
    await new Promise((resolve, reject) => { panel.once('error', reject); panel.listen(port, '127.0.0.1', resolve); });
    serviceUrl = `http://127.0.0.1:${panel.address().port}/`;
    bus.start();
    return {
      bus,
      socketPath,
      url: `http://127.0.0.1:${panel.address().port}/`,
      close,
    };
  } catch (error) { await close(); throw error; }
}

function cursor(url) { const value = Number(url.searchParams.get('after') ?? 0); if (!Number.isSafeInteger(value) || value < 0) throw new Error('游标无效'); return value; }

function readJsonBody(request, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0, data = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > limit) { reject(new Error('请求体过大')); request.destroy(); return; }
      data += chunk;
    });
    request.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('JSON请求体无效')); }
    });
    request.on('error', reject);
  });
}

const panelRoot = fileURLToPath(new URL('../web/dist', import.meta.url));
const contentTypes = new Map([
  ['.html', 'text/html'], ['.js', 'text/javascript'], ['.css', 'text/css'],
  ['.json', 'application/json'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
]);

export function resolvePanelFile(pathname, accept = '') {
  const index = resolve(panelRoot, 'index.html');
  const wantsHtml = accept.includes('text/html');
  if (pathname === '/' || pathname === '/index.html') return { path: index, type: 'text/html' };
  if (pathname.startsWith('/assets/')) {
    const assetsRoot = resolve(panelRoot, 'assets');
    const candidate = resolve(panelRoot, `.${pathname}`);
    if (!candidate.startsWith(`${assetsRoot}${sep}`)) return null;
    return { path: candidate, type: contentTypes.get(extname(candidate)) ?? 'application/octet-stream' };
  }
  if (!extname(pathname) && wantsHtml) return { path: index, type: 'text/html' };
  return null;
}

export async function handleRpc(bus, request) {
  const group = request.group || (request.endpoint ? bus.store.get('SELECT group_id FROM conversations WHERE id=?', request.endpoint)?.group_id : null);
  if (group && !['restore', 'archive', 'delete'].includes(request.op) && bus.store.get('SELECT state FROM groups WHERE id=?', group)?.state === 'archived') throw new Error('团队已归档，请在设置中恢复后访问');
  if (request.op === 'ping') return { version };
  if (request.op === 'control_tools') return bus.controlTools(request.binding, request.key, request.protocolVersion, request.hostSession, request.clearHostSession === true);
  if (request.op === 'control_tool') return bus.controlTool(request.binding, request.key, request.name, request.args, request.protocolVersion, request.hostSession, request.clearHostSession === true);
  if (request.op === 'bind_client_session') return bus.controlPlane.bindSession(request.binding, request.key, request.session, request.protocolVersion);
  if (request.op === 'tools') return bus.endpointTools(request.endpoint, request.key);
  if (request.op === 'tool') return bus.tool(request.endpoint, request.key, request.name, request.args, { turnId: request.turnId });
  if (request.op === 'groups') return bus.store.all("SELECT * FROM groups WHERE state IS NULL OR state!='archived' ORDER BY created");
  if (request.op === 'model_catalog') return bus.modelCatalog({ refresh: request.refresh === true });
  if (request.op === 'new') return bus.createGroup(request.args);
  if (request.op === 'collaboration') return bus.groupSummary(request.group);
  if (request.op === 'charter') return bus.store.group(request.group).charter ?? null;
  if (request.op === 'directive') return bus.directive(request.group, request.text);
  if (request.op === 'archive') return bus.archiveGroup(request.group);
  if (request.op === 'restore') return bus.restoreGroup(request.group);
  if (request.op === 'resolve_runtime') { bus.collaboration.resolveRuntime(request.group, request.turn, request.reason); bus.pump(); return bus.groupSummary(request.group); }
  if (request.op === 'reset_session') return bus.resetSession(request.endpoint, request.reason);
  if (request.op === 'chat') {
    if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 48000) throw new Error('私聊输入无效');
    return bus.privateTurn(request.group, request.text);
  }
  if (request.op === 'members') return bus.members(request.group);
  if (request.op === 'add') return bus.addMember(request.group, request.args);
  if (request.op === 'remove') return bus.removeMember(request.group, request.member);
  if (request.op === 'delete') return bus.deleteGroup(request.group);
  if (request.op === 'retry') return bus.retry(request.group);
  if (request.op === 'stop') {
    const target = bus.resolveMember(request.group, request.member);
    await bus.stopWhere(endpoint => endpoint.member_id === target.id);
    return { stopRequested: target.id };
  }
  throw new Error('未知命令');
}
