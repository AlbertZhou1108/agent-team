import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, readFileSync, unlinkSync, chmodSync, lstatSync, closeSync, existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bus, interactionView } from './bus.mjs';
import { telemetryOverview } from './telemetry-overview.mjs';
import { chooseDirectory } from './directory-picker.mjs';
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
    try { owner = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { throw new Error('无法判断数据目录所有者；请先检查 owner.json'); }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('数据目录锁格式无效');
    try { process.kill(owner.pid, 0); throw new Error('该数据目录已有群总线运行'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    unlinkSync(lockPath);
    lock = openSync(lockPath, 'wx', 0o600);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid })); closeSync(lock);
  let bus, ipc, panel, socketOwned = false;
  const panelEventStreams = new Set();
  const close = async () => {
    if (bus && !bus.closing) await bus.close();
    for (const response of panelEventStreams) response.end();
    panelEventStreams.clear();
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
    bus = new Bus({ directory, hosts: hosts ?? await loadHosts({ directory, socketPath, configFile }) });
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
      const failJson = (status, error) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      };
      try {
        const actualPort = panel.address().port;
        if (request.headers.host !== `127.0.0.1:${actualPort}` && request.headers.host !== `localhost:${actualPort}`) return fail(403, 'Invalid host');
        const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
        if (request.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'Cross-site request rejected');
        const directiveMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/directives$/);
        const isDirectiveMutation = request.method === 'POST' && Boolean(directiveMatch);
        const isDirectoryMutation = request.method === 'POST' && url.pathname === '/api/local/directory-picker';
        const isPolicyMutation = request.method === 'POST' && url.pathname === '/api/model-policy';
        const teamStateMutation = request.method === 'POST' && /^\/api\/teams\/[^/]+\/(?:archive|restore)$/.test(url.pathname);
        const isPanelMutation = request.method === 'POST' && (
          url.pathname === '/api/panel-agent'
          || url.pathname === '/api/panel-agent/update'
          || url.pathname === '/api/panel-agent/messages'
          || url.pathname === '/api/panel-agent/stop'
          || url.pathname === '/api/panel-agent/resolve-runtime'
          || /^\/api\/interactions\/[^/]+\/answer$/.test(url.pathname)
          || /^\/api\/teams\/[^/]+\/(?:takeover|handback)$/.test(url.pathname)
        );
        if (request.method !== 'GET' && !isPolicyMutation && !isPanelMutation && !teamStateMutation && !isDirectiveMutation && !isDirectoryMutation) return fail(403, 'Panel endpoint is not writable');
        if (request.method !== 'GET' && request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return fail(403, 'Cross-origin request rejected');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        if (request.method === 'GET' && url.pathname === '/api/panel-agent/events') {
          panelEventStreams.add(response);
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          response.write(': connected\n\n');
          const send = event => {
            if (!response.writableEnded) {
              response.write(`event: panel-stream\ndata: ${JSON.stringify(event)}\n\n`);
            }
          };
          const active = bus.panelStreaming();
          if (active.length) send({ type: 'snapshot', streams: active });
          bus.on('panel-stream', send);
          const heartbeat = setInterval(() => {
            if (!response.writableEnded) response.write(': heartbeat\n\n');
          }, 15000);
          heartbeat.unref();
          const cleanup = () => {
            clearInterval(heartbeat);
            bus.off('panel-stream', send);
            panelEventStreams.delete(response);
          };
          request.once('close', cleanup);
          response.once('close', cleanup);
          return;
        }
        const teamEventsMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/events$/);
        if (request.method === 'GET' && teamEventsMatch) {
          const groupId = decodeURIComponent(teamEventsMatch[1]);
          bus.store.group(groupId);
          panelEventStreams.add(response);
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          response.write(': connected\n\n');
          const send = event => {
            if (response.writableEnded) return;
            if (event.type === 'snapshot') {
              response.write(`event: team-stream\ndata: ${JSON.stringify(event)}\n\n`);
              return;
            }
            if (event.stream?.groupId !== groupId) return;
            response.write(`event: team-stream\ndata: ${JSON.stringify(event)}\n\n`);
          };
          const active = bus.teamStreaming(groupId);
          if (active.length) send({ type: 'snapshot', streams: active });
          bus.on('team-stream', send);
          const heartbeat = setInterval(() => {
            if (!response.writableEnded) response.write(': heartbeat\n\n');
          }, 15000);
          heartbeat.unref();
          const cleanup = () => {
            clearInterval(heartbeat);
            bus.off('team-stream', send);
            panelEventStreams.delete(response);
          };
          request.once('close', cleanup);
          response.once('close', cleanup);
          return;
        }
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          let value;
          if (isDirectoryMutation) {
            if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return fail(400, '文件夹选择不接受路径或脚本参数');
            value = await chooseDirectory();
          } else if (directiveMatch) {
            const groupId = decodeURIComponent(directiveMatch[1]);
            if (isDirectiveMutation) {
              if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return fail(415, '需要 application/json');
              value = bus.teamDirectives.submit(groupId, await readJsonBody(request));
            } else value = bus.teamDirectives.list(groupId);
          } else if (isPolicyMutation) {
            if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            value = bus.updateModelPolicy({ mode: body.mode, rules: body.rules });
          } else if (teamStateMutation) {
            if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return fail(415, '需要 application/json');
            await readJsonBody(request);
            value = url.pathname.endsWith('/archive')
              ? await bus.archiveGroup(decodeURIComponent(url.pathname.split('/')[3]))
              : bus.restoreGroup(decodeURIComponent(url.pathname.split('/')[3]));
          } else if (isPanelMutation) {
            if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return fail(415, '需要 application/json');
            const body = await readJsonBody(request);
            if (url.pathname === '/api/panel-agent') value = await bus.createPanelAgent(body);
            else if (url.pathname === '/api/panel-agent/update') value = await bus.updatePanelAgent(body);
            else if (url.pathname === '/api/panel-agent/messages') value = await bus.panelPrivateTurn(body.text, body.activeTeamId ?? null);
            else if (url.pathname === '/api/panel-agent/stop') value = await bus.stopPanel();
            else if (url.pathname === '/api/panel-agent/resolve-runtime') value = bus.resolvePanelRuntime(body.turnId, body.reason);
            else {
              const teamMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/(takeover|handback)$/);
              const interactionMatch = url.pathname.match(/^\/api\/interactions\/([^/]+)\/answer$/);
              if (teamMatch) {
                const groupId = decodeURIComponent(teamMatch[1]);
                value = teamMatch[2] === 'takeover'
                  ? bus.takeoverTeam(groupId, body.revision)
                  : bus.handbackTeam(groupId, body.revision);
              } else if (interactionMatch) {
                value = bus.decideInteraction(decodeURIComponent(interactionMatch[1]), body.answer);
              } else return fail(404, 'Not found');
            }
          } else if (url.pathname === '/api/telemetry/overview') {
            value = telemetryOverview(bus, { from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined, bucket: url.searchParams.get('bucket') || 'day' });
          } else if (url.pathname.startsWith('/api/telemetry/')) {
            try {
              const group = url.searchParams.get('group');
              if (!group || !group.trim()) throw Object.assign(new Error('缺少 group 参数'), { status: 400 });
              const options = {
                from: url.searchParams.get('from') || null,
                to: url.searchParams.get('to') || null,
                cursor: url.searchParams.get('cursor'),
                limit: url.searchParams.get('limit') ?? 20,
              };
              if (url.pathname === '/api/telemetry/conversation') {
                const member = url.searchParams.get('member');
                const peer = url.searchParams.get('peer');
                if (!member || !peer) throw Object.assign(new Error('缺少 member 或 peer 参数'), { status: 400 });
                value = bus.telemetryConversation(group, member, peer, options);
              } else if (url.pathname === '/api/telemetry/manager-conversation') {
                const member = url.searchParams.get('member');
                if (!member || !member.trim()) throw Object.assign(new Error('缺少 member 参数'), { status: 400 });
                value = bus.telemetryManagerConversation(group, member, options);
              } else if (url.pathname === '/api/telemetry/coordination') {
                value = bus.telemetryCoordination(group, options);
              } else if (url.pathname === '/api/telemetry/members') {
                value = bus.telemetryMembers(group, options);
              } else if (url.pathname === '/api/telemetry/capabilities') {
                value = bus.telemetryCapabilities(group);
              } else {
                return failJson(404, new Error('Not found'));
              }
            } catch (error) {
              return failJson(error.status ?? 500, error);
            }
          } else if (url.pathname === '/api/snapshot') value = bus.snapshot(url.searchParams.get('scoped') === '1' ? url.searchParams.get('group') || '' : undefined);
          else if (url.pathname === '/api/panel-agent') value = bus.panelAgentState(url.searchParams.get('summary') === '1');
          else if (url.pathname === '/api/panel-agent/conversation') value = bus.panelConversation(cursor(url));
          else if (url.pathname === '/api/panel-agent/teams') value = bus.panelTeamViews();
          else if (url.pathname === '/api/model-policy') value = bus.modelPolicy();
          else if (url.pathname === '/api/model-catalog') value = await bus.modelCatalog({ refresh: url.searchParams.get('refresh') === '1' });
          else if (url.pathname === '/api/collaboration') value = bus.groupSummary(url.searchParams.get('group'));
          else if (url.pathname === '/api/interactions') {
            value = url.searchParams.get('panel') === '1'
              ? bus.store.panelInteractions().map(row => interactionView(row))
              : bus.store.interactions(bus.store.group(url.searchParams.get('group')).id).map(row => interactionView(row));
          }
          else if (url.pathname === '/api/charter') value = bus.store.group(url.searchParams.get('group')).charter ?? null;
          else if (url.pathname === '/api/messages') {
            const group = url.searchParams.get('group'); bus.store.group(group);
            if (url.searchParams.get('latest') === '1') {
              const endpointId = url.searchParams.get('endpoint');
              const endpoint = endpointId ? (bus.store.get('SELECT * FROM endpoints WHERE id=? AND group_id=?', endpointId, group) ?? bus.store.get("SELECT id,panel_agent_id AS member_id,NULL AS peer FROM panel_sessions WHERE id=? AND group_id=? AND context='coordination'", endpointId, group)) : null;
              const params = [group];
              let where = 'group_id=?';
              if (endpointId && !endpoint) return fail(404, '不存在的团队会话');
              if (endpoint?.peer) {
                where += ' AND ((sender=? AND recipient=?) OR (sender=? AND recipient=?))';
                params.push(endpoint.member_id, endpoint.peer, endpoint.peer, endpoint.member_id);
              } else if (endpoint) {
                where += ' AND (sender=? OR recipient=?)';
                params.push(endpoint.member_id, endpoint.member_id);
              }
              const before = Number(url.searchParams.get('before'));
              if (before > 0) { where += ' AND seq<?'; params.push(before); }
              const after = Number(url.searchParams.get('after'));
              if (after > 0) {
                where += ' AND seq>?'; params.push(after);
                value = bus.store.all(`SELECT * FROM messages WHERE ${where} ORDER BY seq LIMIT 200`, ...params);
              } else value = bus.store.all(`SELECT * FROM messages WHERE ${where} ORDER BY seq DESC LIMIT 50`, ...params).reverse();
            } else value = bus.store.all('SELECT * FROM messages WHERE group_id=? AND seq>? ORDER BY seq LIMIT 200', group, cursor(url));
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
  if (request.op === 'ping') return { version: '0.1.0' };
  if (request.op === 'tools') return bus.endpointTools(request.endpoint, request.key);
  if (request.op === 'tool') return bus.tool(request.endpoint, request.key, request.name, request.args, { turnId: request.turnId });
  if (request.op === 'groups') return bus.store.all('SELECT * FROM groups ORDER BY created');
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
