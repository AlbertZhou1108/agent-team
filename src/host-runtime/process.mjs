import { spawnHost as spawn, stopHost } from './subprocess.mjs';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxMode } from '../hosts/policies.mjs';
import { nodeRunner } from '../runtime.mjs';

export const cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url));

/** 堆栈帧与加载器内部行:对用户没有诊断价值,只会在聊天里刷屏。 */
const STACK_FRAME = /^(?:at\s|\S+\s+\(node:|node:|file:\/\/\/\S*\/node_modules\/)/;
/** 能代表根因的行;找不到时退回 stderr 第一行。 */
const ROOT_CAUSE_HINT = /\b(?:error|failed|cannot find|not found|insufficient|quota|unauthori[sz]ed|forbidden|denied|refused|timed?\s?out|invalid)\b/i;
/** Node 的错误输出常带 `Error [ERR_X]: ...`,代码比前面的模块前缀更有信息量。 */
const ERROR_CODE = /Error\s*\[([A-Z][A-Z0-9_]+)\]\s*:\s*(.+)$/;
/** 强根因标记:出现时从标记处起头,丢掉前面「探测了什么」这类过程日志。 */
const STRONG_HINT = /\b(?:QUOTA|Insufficient Balance|Unauthorized|Forbidden|PERMISSION_DENIED|invalid api key|EACCES|ENOENT)\b/i;

/** 长绝对路径压成 `…/文件名`:保留可辨认的落点,不占半屏宽度。 */
function compactPaths(text) {
  return text
    .replace(/file:\/\/\/\S+/g, match => `…/${match.split('/').pop()}`)
    .replace(/\/(?:[\w.@+-]+\/){3,}([\w.@+-]+)/g, (_, name) => `…/${name}`);
}

/** 去掉尾部不成对的右括号:删掉 request_id 一类片段后常留下悬空括号。 */
function trimUnbalanced(text) {
  let open = (text.match(/\(/g) ?? []).length;
  let close = (text.match(/\)/g) ?? []).length;
  let out = text;
  while (close > open && /\)\s*$/.test(out)) {
    out = out.replace(/\)\s*$/, '');
    close -= 1;
  }
  return out;
}

/**
 * 把宿主 stderr 压成一句能读的话:丢掉堆栈帧,优先取含根因关键词的行,
 * 抽出错误代码、从强原因处起头、压平空白与长路径后按上限截断。
 * 完整 stderr 由调用方另存,排查时仍可取回。
 */
export function summarizeHostStderr(stderr, { max = 160 } = {}) {
  const kept = String(stderr ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !STACK_FRAME.test(line));
  if (!kept.length) return '';
  const primary = kept.find(line => ROOT_CAUSE_HINT.test(line)) ?? kept[0];
  const extra = kept.filter(line => line !== primary && ROOT_CAUSE_HINT.test(line)).length;
  const flat = primary.replace(/\s+/g, ' ');
  const code = flat.match(ERROR_CODE);
  let brief = code ? `${code[1]}: ${code[2]}` : flat;
  const strong = brief.match(STRONG_HINT);
  if (!code && strong && strong.index > 0) {
    // 从最近的括号/方括号开始,避免留下半截前缀;切得太碎就保留整行。
    const open = Math.max(brief.lastIndexOf('(', strong.index), brief.lastIndexOf('[', strong.index));
    const candidate = brief.slice(open >= 0 && strong.index - open < 60 ? open + 1 : strong.index);
    if (candidate.length >= 12) brief = candidate;
  }
  brief = trimUnbalanced(compactPaths(brief)
    .replace(/\s*\(request_id:[^)]*\)/gi, '')
    .replace(/[\s(]+$/, ''));
  const cut = brief.length > max ? `${brief.slice(0, max - 1).trimEnd()}…` : brief;
  return extra ? `${cut}(另有 ${extra} 处同类错误)` : cut;
}

/**
 * MCP server 的启动命令会被写进宿主配置，由宿主自己的进程 spawn。
 * runner 可注入，便于在契约测试里覆盖 Electron 分支。
 */
export function mcpConfig({ socketPath, endpoint, turnId, runner = nodeRunner(), cli = cliPath }) {
  return {
    command: runner.command,
    args: ['--disable-warning=ExperimentalWarning', cli, 'mcp', '--socket', socketPath, '--endpoint', endpoint.id],
    env: { ...runner.env, AGENT_TEAM_KEY: endpoint.key, AGENT_TEAM_TURN: turnId },
  };
}

/**
 * Claude 受控启动的 mcp-config 内容：agent_team 永远优先；浏览器 MCP 只克隆探测到的 stdio 配置，
 * 名字冲突/形状不完整一律跳过，绝不替换 agent_team 或猜测配置。
 */
export function claudeMcpServersConfig(config, browserServers = []) {
  const mcpServers = { agent_team: config };
  for (const server of Array.isArray(browserServers) ? browserServers : []) {
    const name = server?.name;
    if (typeof name !== 'string' || !name || name === 'agent_team' || mcpServers[name]) continue;
    const entry = server?.config ?? {};
    if (typeof entry.command !== 'string' || !entry.command) continue;
    mcpServers[name] = {
      command: entry.command,
      args: Array.isArray(entry.args) ? [...entry.args] : [],
      env: entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env) ? { ...entry.env } : {},
      ...(typeof entry.cwd === 'string' && entry.cwd ? { cwd: entry.cwd } : {}),
    };
  }
  return { mcpServers };
}

export function writeMcpFiles(directory, socketPath, endpoint, turnId, execution, { browserServers = [] } = {}) {
  const dir = resolve(directory, 'endpoints', endpoint.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = mcpConfig({ socketPath, endpoint, turnId });
  const claude = resolve(dir, 'claude.json');
  const dsh = resolve(dir, 'dsh.patch.json');
  writeFileSync(claude, JSON.stringify(claudeMcpServersConfig(config, browserServers)), { mode: 0o600 });
  const overlay = [{ insert: [{ id: 'agent-team-mcp', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'agent_team', transport: 'stdio', ...config, failOnStartupError: true, reconnect: { enabled: false } } }] }];
  if (execution) {
    // dsh ≥0.2.2-rc.1 移除了 tools.mode（"Removed. Mount a native or PTC tool
    // executor instead."），原生执行器由 base 默认挂载；再传 native 会使整个
    // tools 行校验失败，连带 agent-loop 等必需插件不激活（no agent factory）。
    overlay.push(
      { id: 'session-persistence-jsonl', config: { root: resolve(directory, 'host-sessions', 'dsh') } },
      { id: 'storage-json', config: { root: resolve(directory, 'host-storage', 'dsh') } },
      { id: 'sandbox-policy', config: { mode: sandboxMode(execution.mode), workspaceRoot: execution.workspace } },
      { id: 'approval', config: { policy: 'never' } },
      { id: 'permission', config: { presets: { team: { sandbox: sandboxMode(execution.mode), approval: 'never' } }, defaultPreset: 'team' } },
    );
    if (execution.modelSelection?.model) {
      if (!execution.modelSelection.model_provider) throw new Error('DSH角色模型缺少model_provider');
      overlay.push({
        id: 'agent-default-model',
        config: {
          provider: execution.modelSelection.model_provider,
          model: execution.modelSelection.model,
          ...(execution.modelSelection.reasoning_effort
            ? { reasoningEffort: execution.modelSelection.reasoning_effort }
            : {}),
        },
      });
    }
    // 这三个插件实现位于 member/dsh/,不是 host-runtime/ —— 路径写错会让 dsh
    // 启动时报 ERR_MODULE_NOT_FOUND 并退出(团队消息投递失败的真正原因)。
    overlay.push(
      { insert: [{ id: 'agent-team-policy', name: fileURLToPath(new URL('../member/dsh/policy.mjs', import.meta.url)), config: execution }] },
      { insert: [{ id: 'agent-team-model-observer', name: fileURLToPath(new URL('../member/dsh/model-observer.mjs', import.meta.url)) }] },
      { insert: [{ id: 'agent-team-telemetry-observer', name: fileURLToPath(new URL('../member/dsh/telemetry-observer.mjs', import.meta.url)) }] },
    );
  }
  writeFileSync(dsh, JSON.stringify(overlay), { mode: 0o600 });
  return { claude, dsh };
}

export function runJsonProcess(command, args, { workspace, signal, onEvent, onRow, env }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('回合已中断'));
    const child = spawn(command, args, { cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    let stderr = '', failure, bytes = 0, stopping;
    const kill = () => {
      stopping ??= stopHost(child).catch(error => { failure = error; reject(error); });
    };
    signal.addEventListener('abort', kill, { once: true });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    createInterface({ input: child.stdout }).on('line', line => {
      bytes += Buffer.byteLength(line);
      if (bytes > 32 * 1024 * 1024) { failure = new Error('单回合输出超过 32 MiB'); kill(); return; }
      if (!line.trim()) return;
      try { const row = JSON.parse(line); onEvent(row); onRow(row); }
      catch (error) { failure = error; kill(); }
    });
    child.on('error', error => { failure = error; });
    child.on('close', (code, reason) => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) return reject(new Error('回合已中断'));
      if (failure) return reject(failure);
      if (code !== 0) {
        const summary = summarizeHostStderr(stderr) || '请检查宿主认证、权限与额度';
        const error = new Error(`${basename(command)} 退出 (${code ?? reason})：${summary}`);
        // 完整 stderr 留在 error.detail:通知只显示摘要,排查时还能拿到原文。
        error.detail = stderr.trim();
        return reject(error);
      }
      resolve();
    });
  });
}
