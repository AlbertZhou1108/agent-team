import net from 'node:net';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, readFileSync, unlinkSync, chmodSync, lstatSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

export async function startServer({ directory, port = 0, hosts, configFile, confirm }) {
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
    panel = http.createServer((request, response) => {
      const fail = (status, text) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(text); };
      try {
        const actualPort = panel.address().port;
        if (request.headers.host !== `127.0.0.1:${actualPort}` && request.headers.host !== `localhost:${actualPort}`) return fail(403, 'Invalid host');
        if (request.method !== 'GET' || request.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'Read-only local panel');
        const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        if (url.pathname === '/' && url.searchParams.get('key') === key) {
          response.writeHead(303, { Location: '/', 'Set-Cookie': `agent_team=${key}; HttpOnly; SameSite=Strict; Path=/` }); return response.end();
        }
        if (!(request.headers.cookie ?? '').split(';').some(part => part.trim() === `agent_team=${key}`)) return fail(401, '请打开启动时输出的面板链接');
        if (url.pathname.startsWith('/api/')) {
          let value;
          if (url.pathname === '/api/snapshot') value = bus.snapshot();
          else if (url.pathname === '/api/messages') {
            const group = url.searchParams.get('group'); bus.store.group(group);
            value = bus.store.all('SELECT * FROM messages WHERE group_id=? AND seq>? ORDER BY seq LIMIT 200', group, cursor(url));
          } else if (url.pathname === '/api/message-trace') {
            value = bus.store.messageTrace(url.searchParams.get('message'));
            if (!value) return fail(404, 'Not found');
          } else if (url.pathname === '/api/turn') {
            value = bus.store.turnTrace(url.searchParams.get('turn'), cursor(url));
            if (!value) return fail(404, 'Not found');
          } else if (url.pathname === '/api/history') {
            const endpoint = bus.store.get("SELECT id FROM endpoints WHERE id=? AND context!='private'", url.searchParams.get('endpoint'));
            if (!endpoint) return fail(404, '不存在可观测的群会话');
            value = bus.store.all('SELECT * FROM history WHERE endpoint_id=? AND seq>? ORDER BY seq LIMIT 200', endpoint.id, cursor(url));
          } else return fail(404, 'Not found');
          response.writeHead(200, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify(value));
        }
        const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
        const file = files[url.pathname];
        if (!file) return fail(404, 'Not found');
        response.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); response.end(readFileSync(new URL(`../web/${file[0]}`, import.meta.url)));
      } catch (error) { fail(400, error.message); }
    });
    await new Promise((resolve, reject) => { panel.once('error', reject); panel.listen(port, '127.0.0.1', resolve); });
    bus.start();
    return { bus, socketPath, url: `http://127.0.0.1:${panel.address().port}/?key=${key}`, close };
  } catch (error) { await close(); throw error; }
}

function cursor(url) { const value = Number(url.searchParams.get('after') ?? 0); if (!Number.isSafeInteger(value) || value < 0) throw new Error('游标无效'); return value; }

export async function handleRpc(bus, request) {
  if (request.op === 'ping') return { version: '0.1.0' };
  if (request.op === 'tools') { const endpoint = bus.store.authenticate(request.endpoint, request.key); return toolsFor(bus.store.member(endpoint.member_id).role); }
  if (request.op === 'tool') return bus.tool(request.endpoint, request.key, request.name, request.args, { turnId: request.turnId });
  if (request.op === 'groups') return bus.store.all('SELECT * FROM groups ORDER BY created');
  if (request.op === 'new') return bus.createGroup(request.args);
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
