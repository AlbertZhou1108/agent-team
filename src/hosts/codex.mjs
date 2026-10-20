import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function createCodexHost({ command = 'codex', model }) {
  let child, init, nextId = 0, stderr = '';
  const pending = new Map(), active = new Map(), ended = new Map(), waits = new Map();
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const fail = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    for (const entry of waits.values()) { clearTimeout(entry.timer); entry.reject(error); }
    waits.clear();
    child = null; init = null;
  };
  function request(method, params, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} 超时`)); }, timeout);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  async function receive(row) {
    if ('id' in row && !row.method) {
      const entry = pending.get(row.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(row.id); row.error ? entry.reject(new Error(row.error.message)) : entry.resolve(row.result); }
      return;
    }
    const context = active.get(row.params?.threadId);
    context?.onEvent(row);
    if ('id' in row && row.method) {
      if (row.method !== 'item/tool/call' || !context) return send({ id: row.id, error: { code: -32601, message: 'Unowned or unsupported request' } });
      const name = row.params.tool;
      if (!name.startsWith('agent_team_')) return send({ id: row.id, error: { code: -32601, message: 'Unowned tool' } });
      try { const value = await context.onTool(name.slice(11), row.params.arguments, { nativeCallId: row.params.callId }); send({ id: row.id, result: { contentItems: [{ type: 'inputText', text: JSON.stringify(value) }], success: true } }); }
      catch (error) { send({ id: row.id, result: { contentItems: [{ type: 'inputText', text: error.message }], success: false } }); }
    }
    if (row.method === 'item/completed' && row.params.item?.type === 'agentMessage' && context) context.text = row.params.item.text ?? '';
    if (row.method === 'turn/completed') {
      const turn = row.params.turn;
      const waiter = waits.get(turn.id);
      if (waiter) { clearTimeout(waiter.timer); waits.delete(turn.id); waiter.resolve(turn); }
      else ended.set(turn.id, turn);
    }
  }
  async function ready() {
    if (init) return init;
    init = (async () => {
      child = spawn(command, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
      child.on('error', fail);
      child.on('exit', (code, signal) => fail(new Error(`Codex app-server 退出 (${code ?? signal})：${stderr}`)));
      createInterface({ input: child.stdout }).on('line', line => {
        try { const row = JSON.parse(line); receive(row).catch(error => fail(error)); }
        catch { /* Non-protocol stdout is ignored; protocol requests still time out honestly. */ }
      });
      await request('initialize', { clientInfo: { name: 'agent-team', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      send({ method: 'initialized' });
    })();
    return init;
  }
  return {
    async run(context) {
      await ready();
      const { endpoint, prompt, instructions, onSession, onAccepted, signal } = context;
      if (signal.aborted) throw new Error('回合已中断');
      const options = { cwd: context.workspace, approvalPolicy: 'never', sandbox: 'workspace-write', developerInstructions: instructions, ...(model ? { model } : {}) };
      const result = endpoint.session
        ? await request('thread/resume', { threadId: endpoint.session, ...options })
        : await request('thread/start', { ...options, dynamicTools: context.tools.map(tool => ({ type: 'function', name: `agent_team_${tool.name}`, description: tool.description, inputSchema: tool.inputSchema })) });
      const thread = result.thread.id;
      onSession(thread);
      const live = { ...context, text: '' };
      active.set(thread, live);
      let turn;
      const interrupt = () => { if (turn) request('turn/interrupt', { threadId: thread, turnId: turn.id }, 10000).catch(() => {}); };
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        if (signal.aborted) throw new Error('回合已中断');
        turn = (await request('turn/start', { threadId: thread, input: [{ type: 'text', text: prompt }] })).turn;
        context.onNativeTurn(turn.id);
        onAccepted();
        if (signal.aborted) interrupt();
        const complete = ended.get(turn.id) ?? await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waits.delete(turn.id); interrupt(); reject(new Error('Codex 回合超过 15 分钟，已请求中断')); }, 900000);
          waits.set(turn.id, { resolve, reject, timer });
        });
        ended.delete(turn.id);
        if (complete.status !== 'completed') throw new Error(complete.error?.message ?? `Codex 回合 ${complete.status}`);
        return live.text;
      } finally { signal.removeEventListener('abort', interrupt); active.delete(thread); }
    },
    async close() {
      const process = child;
      if (!process) return;
      process.kill('SIGTERM');
      await new Promise(resolve => { const timer = setTimeout(() => { process.kill('SIGKILL'); resolve(); }, 2000); process.once('exit', () => { clearTimeout(timer); resolve(); }); });
    },
  };
}
