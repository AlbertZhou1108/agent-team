import net from 'node:net';
import { createInterface } from 'node:readline';

export function rpc(socketPath, request, timeout = 960000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => socket.destroy(new Error('群总线请求超时')), timeout);
    let buffer = '', answered = false;
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return socket.destroy(new Error('响应过大，请分页读取'));
      if (!buffer.includes('\n')) return;
      answered = true;
      try { const result = JSON.parse(buffer.split('\n')[0]); result.error ? reject(new Error(result.error)) : resolve(result.result); }
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
      if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agent-team', version: '0.1.0' } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: await rpc(socketPath, { op: 'tools', endpoint, key }) };
      else if (request.method === 'tools/call') {
        try {
          const value = await rpc(socketPath, { op: 'tool', endpoint, key, turnId, name: request.params?.name, args: request.params?.arguments ?? {} });
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
        } catch (error) { result = { content: [{ type: 'text', text: error.message }], isError: true }; }
      } else return output({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported method' } });
      output({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) { if (request && 'id' in request) output({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } }); }
  });
}
