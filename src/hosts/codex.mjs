import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { executionPolicy, codexPolicyConfig, policyObservation } from './policies.mjs';

export function createCodexHost({ command = 'codex', model, reasoningEffort }) {
  let child, init, nextId = 0, stderr = '', serverNames = [];
  const pending = new Map(), active = new Map(), ended = new Map(), waits = new Map();
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const fail = error => {
    error.runtimeUnknown = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    for (const entry of waits.values()) { clearTimeout(entry.timer); entry.reject(error); }
    waits.clear();
    child = null; init = null;
  };
  function request(method, params, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`Codex ${method} 超时，宿主执行状态待核实`), { runtimeUnknown: true })); }, timeout);
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
    if (row.method === 'item/started' && row.params.item?.type === 'collabAgentToolCall' && context) {
      const turnId = row.params.turnId;
      const error = new Error('Codex 原生子 Agent/协同工具不属于团队回合，已请求中断；请只结束当前回合，由框架投递下一条消息');
      context.violation ??= error;
      const waiter = waits.get(turnId);
      if (waiter) { clearTimeout(waiter.timer); waits.delete(turnId); waiter.reject(error); }
      request('turn/interrupt', { threadId: row.params.threadId, turnId }, 10000).catch(() => {});
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
      const configuration = await request('config/read', { includeLayers: false });
      serverNames = Object.keys(configuration.config?.mcp_servers ?? {});
    })();
    return init;
  }
  return {
    sessionKey({ policy }) { return policy.domain ?? (policy.mode === 'communication' ? 'communication' : 'project'); },
    supportsPolicy({ policy }) {
      return policy.mode === 'communication' || policy.allowShell
        ? { supported: true }
        : { supported: false, reason: '当前 Codex 项目模式没有独立文件编辑工具，需要契约允许沙箱命令' };
    },
    async run(context) {
      await ready();
      const { endpoint, prompt, instructions, onSession, onAccepted, signal } = context;
      if (signal.aborted) throw new Error('回合已中断');
      const policy = executionPolicy(context);
      if (policy.mode !== 'communication' && !policy.allowShell) throw new Error('Codex项目操作需要契约明确允许沙箱命令；请调整安排或由用户批准契约变更');
      const config = { ...codexPolicyConfig(policy, serverNames), ...(reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}) };
      const signature = JSON.stringify({ config, tools: context.tools.map(t => t.name) });
      if (endpoint.session && context.previousPolicy?.signature !== signature) throw new Error('Codex会话工具配置已变更或尚未验证；请由用户reset-session后重新建立，不会静默切换会话');
      const options = {
        cwd: context.workspace, approvalPolicy: 'never', sandbox: policy.mode === 'workspace-write' ? 'workspace-write' : 'read-only', developerInstructions: instructions,
        ...(model ? { model } : {}),
        config,
      };
      if (model || reasoningEffort) context.onModel({ phase: 'requested', model: model ?? null, reasoningEffort: reasoningEffort ?? null, source: 'adapter.config' });
      const result = endpoint.session
        ? await request('thread/resume', { threadId: endpoint.session, ...options })
        : await request('thread/start', { ...options, dynamicTools: context.tools.map(tool => ({ type: 'function', name: `agent_team_${tool.name}`, description: tool.description, inputSchema: tool.inputSchema })) });
      const thread = result.thread.id;
      context.onPolicy?.({ ...policyObservation('codex', policy, { config, turnSandbox: policy.mode === 'workspace-write' ? 'workspaceWrite' : 'readOnly', tools: context.tools.map(t => t.name) }), signature });
      context.onModel({
        phase: 'session', model: result.model, provider: result.modelProvider, reasoningEffort: result.reasoningEffort,
        source: endpoint.session ? 'codex.thread_resume' : 'codex.thread_start',
      });
      onSession(thread);
      const live = { ...context, text: '' };
      active.set(thread, live);
      let turn;
      const interrupt = () => { if (turn) request('turn/interrupt', { threadId: thread, turnId: turn.id }, 10000).catch(() => {}); };
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        if (signal.aborted) throw new Error('回合已中断');
        turn = (await request('turn/start', { threadId: thread, input: [{ type: 'text', text: prompt }], approvalPolicy: 'never', sandboxPolicy: policy.mode === 'workspace-write'
          ? { type: 'workspaceWrite', writableRoots: [context.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false } })).turn;
        context.onNativeTurn(turn.id);
        onAccepted();
        if (signal.aborted) interrupt();
        if (live.violation) throw live.violation;
        const complete = ended.get(turn.id) ?? await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waits.delete(turn.id); interrupt(); reject(Object.assign(new Error('Codex 回合超过 15 分钟，已请求中断，停止结果待核实'), { runtimeUnknown: true })); }, 900000);
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
