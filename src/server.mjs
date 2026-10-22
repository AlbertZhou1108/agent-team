import net from 'node:net';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, readFileSync, unlinkSync, chmodSync, lstatSync, closeSync, existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bus } from './bus.mjs';
import { toolsFor } from './tools.mjs';
import { rpc } from './rpc.mjs';
import { createCodexHost } from './hosts/codex.mjs';
import { createClaudeHost, createDshHost } from './hosts/cli-hosts.mjs';

export function socketFor(directory) {
  const candidate = resolve(directory, 'bus.sock');
  return Buffer.byteLength(candidate) < 100 ? candidate : `/tmp/agent-team-${process.getuid?.() ?? 'local'}-${createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 20)}.sock`;
}
export async function loadHosts({ directory, socketPath, configFile }) {
  socketPath ??= socketFor(directory);
  const factories = new Map([['codex', createCodexHost], ['claude', createClaudeHost], ['dsh', createDshHost]]);
  const specs = configFile ? JSON.parse(readFileSync(resolve(configFile), 'utf8')).hosts : { codex: { adapter: 'codex' }, claude: { adapter: 'claude' }, dsh: { adapter: 'dsh' } };
  if (!specs || typeof specs !== 'object' || Array.isArray(specs)) throw new Error('宿主配置需要 hosts 对象');
  const hosts = new Map();
  for (const [name, spec] of Object.entries(specs)) {
    const factory = spec.module ? (await import(pathToFileURL(resolve(spec.module)).href)).createHost : factories.get(spec.adapter);
    if (typeof factory !== 'function') throw new Error(`未配置宿主适配器: ${name}`);
    const host = await factory({ directory, socketPath, ...spec });
    if (typeof host?.run !== 'function') throw new Error(`宿主缺少 run 接口: ${name}`);
    hosts.set(name, host);
  }
  return hosts;
}

export async function startServer({ directory, port = 0, hosts, configFile, confirm, panelAuth = true }) {
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const socketPath = socketFor(directory), lockPath = resolve(directory, 'owner.json');
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { throw new Error('无法判断数据目录所有者；请先检查 owner.json'); }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('数据目录锁格式无效');
    try { process.kill(owner.pid, 0); throw new Error('该数据目录已有群总线运行'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    unlinkSync(lockPath);
    lock = openSync(lockPath, 'wx', 0o600);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid })); closeSync(lock);
  let bus, ipc, panel, socketOwned = false;
  const key = randomBytes(32).toString('hex');
  const close = async () => {
    if (bus && !bus.closing) await bus.close();
    await Promise.all([ipc, panel].filter(Boolean).map(server => new Promise(resolve => { if (server.listening) server.close(resolve); else resolve(); })));
    if (socketOwned) { try { unlinkSync(socketPath); } catch { /* net.Server may have removed it. */ } }
    try { if (JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid) unlinkSync(lockPath); } catch { /* Already cleaned up. */ }
  };
  try {
    try {
      if (lstatSync(socketPath).isSocket()) {
        try { await rpc(socketPath, { op: 'ping' }, 1500); throw new Error('已有群总线使用此 socket'); }
        catch (error) { if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error; }
        unlinkSync(socketPath);
      } else throw new Error('socket 路径被其他文件占用');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    bus = new Bus({ directory, hosts: hosts ?? await loadHosts({ directory, socketPath, configFile }), confirm });
    ipc = net.createServer(socket => {
      let data = '', handled = false;
      socket.setTimeout(960000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', async chunk => {
        if (handled) return;
        data += chunk;
        if (data.length > 1024 * 1024) return socket.destroy();
        if (!data.includes('\n')) return;
        handled = true;
        try { const value = await handleRpc(bus, JSON.parse(data.split('\n')[0])); socket.end(JSON.stringify({ result: value }) + '\n'); }
        catch (error) { socket.end(JSON.stringify({ error: error.message }) + '\n'); }
      });
    });
    await new Promise((resolve, reject) => { ipc.once('error', reject); ipc.listen(socketPath, resolve); });
    socketOwned = true; chmodSync(socketPath, 0o600);
    panel = http.createServer(async (request, response) => {
      const fail = (status, text) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(text); };
      try {
        const actualPort = panel.address().port;
        if (request.headers.host !== `127.0.0.1:${actualPort}` && request.headers.host !== `localhost:${actualPort}`) return fail(403, 'Invalid host');
        const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
        if (request.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'Cross-site request rejected');
        const isPolicyMutation = request.method === 'POST' && url.pathname === '/api/model-policy';
        const isPanelMutation = request.method === 'POST' && (
          url.pathname === '/api/panel-agent'
          || url.pathname === '/api/panel-agent/update'
          || url.pathname === '/api/panel-agent/messages'
          || url.pathname === '/api/panel-agent/stop'
          || url.pathname === '/api/panel-agent/resolve-runtime'
          || /^\/api\/panel-actions\/[^/]+\/decide$/.test(url.pathname)
          || /^\/api\/preparations\/[^/]+\/approve$/.test(url.pathname)
          || /^\/api\/teams\/[^/]+\/(?:takeover|handback)$/.test(url.pathname)
        );
        if (request.method !== 'GET' && !isPolicyMutation && !isPanelMutation) return fail(403, 'Panel endpoint is not writable');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        if (panelAuth && url.pathname === '/' && url.searchParams.get('key') === key) {
          response.writeHead(303, { Location: '/', 'Set-Cookie': `agent_team=${key}; HttpOnly; SameSite=Strict; Path=/` }); return response.end();
        }
        if (panelAuth && !(request.headers.cookie ?? '').split(';').some(part => part.trim() === `agent_team=${key}`)) return fail(401, '请打开启动时输出的面板链接');
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          let value;
          if (isPolicyMutation) {
            if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            value = bus.updateModelPolicy({ mode: body.mode, rules: body.rules });
          } else if (isPanelMutation) {
            if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (url.pathname === '/api/panel-agent') value = await bus.createPanelAgent(body);
            else if (url.pathname === '/api/panel-agent/update') value = await bus.updatePanelAgent(body);
            else if (url.pathname === '/api/panel-agent/messages') value = await bus.panelPrivateTurn(body.text, body.activeTeamId ?? null);
            else if (url.pathname === '/api/panel-agent/stop') value = await bus.stopPanel();
            else if (url.pathname === '/api/panel-agent/resolve-runtime') value = bus.resolvePanelRuntime(body.turnId, body.reason);
            else {
              const preparationMatch = url.pathname.match(/^\/api\/preparations\/([^/]+)\/approve$/);
              const teamMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/(takeover|handback)$/);
              const actionMatch = url.pathname.match(/^\/api\/panel-actions\/([^/]+)\/decide$/);
              if (preparationMatch) {
                value = bus.confirmPreparation(
                  decodeURIComponent(preparationMatch[1]),
                  body.revision,
                  body.hash,
                );
              } else if (teamMatch) {
                const groupId = decodeURIComponent(teamMatch[1]);
                value = teamMatch[2] === 'takeover'
                  ? bus.takeoverTeam(groupId, body.revision)
                  : bus.handbackTeam(groupId, body.revision);
              } else if (actionMatch) {
                value = bus.decidePanelControllerAction(decodeURIComponent(actionMatch[1]), body.approved === true);
              } else return fail(404, 'Not found');
            }
          } else if (url.pathname === '/api/snapshot') value = bus.snapshot();
          else if (url.pathname === '/api/panel-agent') value = bus.panelAgentState();
          else if (url.pathname === '/api/panel-agent/conversation') value = bus.panelConversation(cursor(url));
          else if (url.pathname === '/api/panel-agent/teams') value = bus.panelTeamViews();
          else if (url.pathname === '/api/model-policy') value = bus.modelPolicy();
          else if (url.pathname === '/api/model-catalog') value = await bus.modelCatalog({ refresh: url.searchParams.get('refresh') === '1' });
          else if (url.pathname === '/api/collaboration') value = bus.collaboration.read(url.searchParams.get('group'), cursor(url));
          else if (url.pathname === '/api/messages') {
            const group = url.searchParams.get('group'); bus.store.group(group);
            value = bus.store.all('SELECT * FROM messages WHERE group_id=? AND seq>? ORDER BY seq LIMIT 200', group, cursor(url));
          } else if (url.pathname === '/api/message-trace') {
            value = bus.store.messageTrace(url.searchParams.get('message'));
            if (!value) return fail(404, 'Not found');
          } else if (url.pathname === '/api/turn') {
            value = bus.store.turnTrace(url.searchParams.get('turn'), cursor(url));
            if (!value) return fail(404, 'Not found');
          } else if (url.pathname === '/api/models') {
            value = bus.store.endpointModels(url.searchParams.get('endpoint'), cursor(url));
            if (!value) return fail(404, '不存在可观测的群会话');
          } else if (url.pathname === '/api/history') {
            const endpoint = bus.store.get("SELECT id FROM endpoints WHERE id=? AND context!='private'", url.searchParams.get('endpoint'));
            const panelSession = endpoint ? null : bus.store.get("SELECT id FROM panel_sessions WHERE id=? AND context='coordination'", url.searchParams.get('endpoint'));
            if (!endpoint && !panelSession) return fail(404, '不存在可观测的群会话');
            value = endpoint
              ? bus.store.all('SELECT * FROM history WHERE endpoint_id=? AND seq>? ORDER BY seq LIMIT 200', endpoint.id, cursor(url))
              : bus.store.all('SELECT * FROM panel_history WHERE session_id=? AND seq>? ORDER BY seq LIMIT 200', panelSession.id, cursor(url));
          } else return fail(404, 'Not found');
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
    bus.start();
    return {
      bus,
      socketPath,
      url: panelAuth ? `http://127.0.0.1:${panel.address().port}/?key=${key}` : `http://127.0.0.1:${panel.address().port}/`,
      panelAuth,
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
  if (request.op === 'ping') return { version: '0.1.0' };
  if (request.op === 'tools') return bus.endpointTools(request.endpoint, request.key);
  if (request.op === 'tool') return bus.tool(request.endpoint, request.key, request.name, request.args, { turnId: request.turnId });
  if (request.op === 'groups') return bus.store.all('SELECT * FROM groups ORDER BY created');
  if (request.op === 'model_catalog') return bus.modelCatalog({ refresh: request.refresh === true });
  if (request.op === 'new') return bus.createGroup(request.args);
  if (request.op === 'prepare') return bus.prepareGroup(request.args);
  if (request.op === 'preparation') return bus.collaboration.preparation(request.id);
  if (request.op === 'propose') return bus.collaboration.propose(request.id, request.contract, request.revision);
  if (request.op === 'preparation_chat') return bus.preparationTurn(request.id, request.text);
  if (request.op === 'approve_preparation') return bus.confirmPreparation(request.id, request.revision, request.hash);
  if (request.op === 'collaboration') return bus.collaboration.read(request.group, request.after ?? 0);
  if (request.op === 'decide') return bus.decideRequest(request.group, request.id, request.approved === true, request.version);
  if (request.op === 'directive') return bus.directive(request.group, request.text);
  if (request.op === 'terminate') return bus.terminate(request.group, request.reason);
  if (request.op === 'reopen') { bus.collaboration.reopen(request.group, request.reason); return bus.collaboration.read(request.group); }
  if (request.op === 'resolve_runtime') { bus.collaboration.resolveRuntime(request.group, request.turn, request.reason); bus.reconcile(request.group); return bus.collaboration.read(request.group); }
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
