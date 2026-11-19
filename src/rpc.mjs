import { version } from './version.mjs';
import { HOST_DEFINITIONS } from './hosts/definitions.mjs';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';

export function rpc(socketPath, request, timeout = 960000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    const timer = setTimeout(() => socket.destroy(new Error('群总线请求超时')), timeout);
    let receivedBytes = 0;
    let buffer = '', answered = false;
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      receivedBytes += Buffer.byteLength(chunk, 'utf8');
      buffer += chunk;
      if (receivedBytes > 4 * 1024 * 1024) return socket.destroy(new Error('响应过大，请分页读取'));
      if (!buffer.includes('\n')) return;
      answered = true;
      try {
        const result = JSON.parse(buffer.split('\n')[0]);
        if (result.error) {
          const error = new Error(result.error);
          if (result.code) error.code = result.code;
          if (result.details) error.details = result.details;
          reject(error);
        } else resolve(result.result);
      }
      catch (error) { reject(error); }
      socket.end();
    });
    socket.on('error', reject);
    socket.on('close', () => { clearTimeout(timer); if (!answered) reject(new Error('群总线在返回结果前断开连接')); });
  });
}

export async function serveMcp(socketPath, endpoint, key, turnId) {
  if (!key || !turnId) throw new Error('缺少框架提供的端点来源标识');
  const input = createInterface({ input: process.stdin });
  const output = result => process.stdout.write(JSON.stringify(result) + '\n');
  input.on('line', async line => {
    let request;
    try {
      request = JSON.parse(line);
      if (!('id' in request)) return;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agent-team', version } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: await rpc(socketPath, { op: 'tools', endpoint, key }) };
      else if (request.method === 'tools/call') {
        try {
          const value = await rpc(socketPath, { op: 'tool', endpoint, key, turnId, name: request.params?.name, args: request.params?.arguments ?? {} });
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
        } catch (error) {
          result = {
            content: [{ type: 'text', text: error.code ? JSON.stringify({ code: error.code, message: error.message, details: error.details ?? null }) : error.message }],
            isError: true,
          };
        }
      } else return output({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported method' } });
      output({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) { if (request && 'id' in request) output({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } }); }
  });
}

export async function serveControlMcp(socketPath, bindingId, key) {
  if (!bindingId || !key) throw new Error('缺少外部主控连接凭据');
  const hostContext = controlHostContext(process.env);
  let clearHostSession = hostContext.clearExistingSession;
  const input = createInterface({ input: process.stdin });
  const output = result => process.stdout.write(JSON.stringify(result) + '\n');
  input.on('line', async line => {
    let request;
    try {
      request = JSON.parse(line);
      if (!('id' in request)) return;
      let result;
      if (request.method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-team-control', version },
        };
      } else if (request.method === 'ping') {
        result = {};
      } else if (request.method === 'tools/list') {
        const clearSessionForThisRequest = clearHostSession;
        clearHostSession = false;
        result = {
          tools: await rpc(socketPath, {
            op: 'control_tools',
            binding: bindingId,
            key,
            protocolVersion: Number(process.env.AGENT_TEAM_CONTROL_PROTOCOL) || null,
            hostSession: hostContext.session,
            clearHostSession: clearSessionForThisRequest,
            hostCwd: hostContext.cwd,
          }),
        };
      } else if (request.method === 'tools/call') {
        try {
          const clearSessionForThisRequest = clearHostSession;
          clearHostSession = false;
          const value = await rpc(socketPath, {
            op: 'control_tool',
            binding: bindingId,
            key,
            protocolVersion: Number(process.env.AGENT_TEAM_CONTROL_PROTOCOL) || null,
            hostSession: hostContext.session,
            clearHostSession: clearSessionForThisRequest,
            hostCwd: hostContext.cwd,
            name: request.params?.name,
            args: request.params?.arguments ?? {},
          });
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
        } catch (error) {
          result = {
            content: [{ type: 'text', text: error.code ? JSON.stringify({ code: error.code, message: error.message, details: error.details ?? null }) : error.message }],
            isError: true,
          };
        }
      } else {
        return output({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported method' } });
      }
      output({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      if (request && 'id' in request) output({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } });
    }
  });
}

/**
 * 主控会话与工作目录发现按宿主收敛在 hosts/definitions.mjs（discoverControllerSession /
 * 可选 discoverControllerWorkspace），按定义顺序探测：Codex 最先，保留 multi-agent
 * 子会话的降级语义。MCP 子进程会继承宿主环境；外围启动器也可通过
 * bind_client_session 或 AGENT_TEAM_HOST_SESSION/AGENT_TEAM_HOST_CWD 明确绑定。
 * 工作目录的兜底事实是 MCP 子进程自身 cwd——宿主专属通道在后续桌面切片里接入。
 */
export function controllerWorkingDirectory(env = process.env) {
  const explicit = env.AGENT_TEAM_HOST_CWD?.trim();
  if (explicit) return explicit;
  try {
    return realpathSync(process.cwd());
  } catch {
    return process.cwd();
  }
}

export function controlHostContext(env = process.env) {
  const fallbackCwd = controllerWorkingDirectory(env);
  if (env.AGENT_TEAM_DISABLE_ACTIVE_WAKE === '1') {
    return { session: null, clearExistingSession: true, cwd: fallbackCwd };
  }
  const explicit = env.AGENT_TEAM_HOST_SESSION?.trim();
  if (explicit) return { session: explicit, clearExistingSession: false, cwd: fallbackCwd };
  for (const definition of HOST_DEFINITIONS.values()) {
    const verdict = definition.discoverControllerSession?.(env);
    if (verdict) return { ...verdict, cwd: definition.discoverControllerWorkspace?.(env) ?? fallbackCwd };
  }
  return {
    session: null,
    clearExistingSession: false,
    cwd: fallbackCwd,
  };
}

export function controlHostSession(env = process.env) {
  return controlHostContext(env).session;
}
