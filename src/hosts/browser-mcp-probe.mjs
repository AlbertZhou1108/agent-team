import { accessSync, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { isBrowserMcpServer } from './policies.mjs';

/**
 * 非 Codex 宿主的浏览器 MCP 实查探测。
 *
 * 设计约束（与 spec §3.2 对齐）：
 * - 同步、只读、不 spawn 进程、不发网络请求；只读宿主用户配置目录里的声明。
 * - 绝不抛错：任何读取/解析异常都退化为「未检测到」，由调用方如实把 tool.browser 置 false。
 * - 短超时：默认 200ms，超过后停止读取剩余配置并保守返回 false。
 * - 只把「stdio command 真实可执行」的声明算作可用；HTTP/SSE 声明无法在启动前同步确认可达，
 *   一律记为未验证，绝不据此点亮能力名片。
 * - 不按模型名或自然语言猜测，只按 BROWSER_MCP_PATTERN 的 server 名白名单匹配。
 */

export const BROWSER_MCP_PROBE_DEADLINE_MS = 200;
export const BROWSER_MCP_MAX_CONFIG_BYTES = 256 * 1024;
export const DSH_MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client';
export const DSH_PROBE_PROFILE = 'headless';

/** 统一的「未检测到」原因前缀；调用方（browserToolCapability）会把它放进 effectivePolicy.browserReason。 */
export const BROWSER_MCP_UNAVAILABLE_REASON = '已开启浏览器/Computer Use 授权，但当前宿主未检测到可用浏览器或 Computer Use 工具';

const HOST_LABELS = Object.freeze({ claude: 'Claude Code', dsh: 'DSH', zcode: 'ZCode' });
const DSH_BLOCK_KEYS = ['serverName', 'transport', 'command', 'url', 'disabled', 'enabled'];
const DSH_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

function hostLabel(host) {
  return HOST_LABELS[host] ?? String(host ?? '未知宿主');
}

/** 默认配置文件读取：只接受普通文件，并对体积设上限，避免异常配置拖慢启动。 */
export function defaultReadText(path) {
  const stats = statSync(path);
  if (!stats.isFile()) throw Object.assign(new Error('不是普通文件'), { code: 'ENOTFILE' });
  if (stats.size > BROWSER_MCP_MAX_CONFIG_BYTES) throw Object.assign(new Error('配置文件超过探测体积上限'), { code: 'E2BIG' });
  return readFileSync(path, 'utf8');
}

/**
 * 把 command 解析成真实可执行文件（PATH 或绝对路径），只读检查不执行。
 * 返回绝对路径或 null；绝不抛错。
 */
export function resolveHostCommand(command, { env = process.env, platform = process.platform } = {}) {
  if (typeof command !== 'string' || !command) return null;
  const executable = candidate => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch { return false; }
  };
  if (command.includes('/') || command.includes('\\')) return executable(command) ? resolve(command) : null;
  const pathValue = env?.PATH;
  if (typeof pathValue !== 'string' || !pathValue) return null;
  const extensions = platform === 'win32'
    ? String(env?.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const directory of pathValue.split(platform === 'win32' ? ';' : delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (executable(candidate)) return resolve(candidate);
    }
  }
  return null;
}

/** 从 JSON 配置声明里取出可克隆的 stdio 配置；形状不完整时返回 null（不猜）。 */
function stdioConfig(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.command !== 'string' || !entry.command) return null;
  const config = { command: entry.command };
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string')) return null;
    config.args = [...entry.args];
  }
  if (entry.env !== undefined) {
    if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)) return null;
    const env = {};
    for (const [key, value] of Object.entries(entry.env)) {
      if (typeof value !== 'string') return null;
      env[key] = value;
    }
    config.env = env;
  }
  if (typeof entry.cwd === 'string' && entry.cwd) config.cwd = entry.cwd;
  return config;
}

function looksHttp(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.url === 'string' && entry.url) return true;
  return typeof entry.type === 'string' && ['http', 'sse', 'streamable-http', 'streamable_http'].includes(entry.type.toLowerCase());
}

function createState({ now, deadlineMs, notes }) {
  const state = { started: now(), timedOut: false, notes, checked: [] };
  state.withinDeadline = () => {
    if (state.timedOut) return false;
    if (now() - state.started > deadlineMs) { state.timedOut = true; return false; }
    return true;
  };
  return state;
}

/** 单文件读取：缺文件（ENOENT/ENOTDIR）视为正常未配置；其他异常只记 note 并继续。 */
function readConfigText(readText, path, state) {
  if (!state.withinDeadline()) return null;
  try {
    const text = readText(path);
    if (typeof text !== 'string') { state.notes.push(`${path}：读取结果不是文本`); return null; }
    if (text.length > BROWSER_MCP_MAX_CONFIG_BYTES) { state.notes.push(`${path}：配置超过探测体积上限`); return null; }
    return text;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    state.notes.push(`${path}：${error?.code ?? error?.message ?? '读取失败'}`);
    return null;
  }
}

function parseJson(text, path, state) {
  try { return JSON.parse(text); }
  catch { state.notes.push(`${path}：JSON 解析失败`); return null; }
}

/** Claude Code：配置目录与 home 两处的 .claude.json 顶层 mcpServers 都读（顺序：配置目录优先）。 */
function collectClaudeDeclarations({ configDirectory, home }, readText, state) {
  const paths = [];
  const add = path => { if (typeof path === 'string' && path && !paths.includes(path)) paths.push(path); };
  if (typeof configDirectory === 'string' && configDirectory) add(join(configDirectory, '.claude.json'));
  if (typeof home === 'string' && home) add(join(home, '.claude.json'));
  const declarations = [];
  for (const path of paths) {
    state.checked.push(path);
    const text = readConfigText(readText, path, state);
    if (text == null) continue;
    const parsed = parseJson(text, path, state);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const [name, entry] of Object.entries(servers)) declarations.push({ name, entry, source: path });
  }
  return declarations;
}

/** ZCode：隔离 HOME 之前读取桌面端真实用户配置 mcp.servers；enabled:false 视为未启用。 */
function collectZcodeDeclarations({ home }, readText, state) {
  if (typeof home !== 'string' || !home) return [];
  const path = join(home, '.zcode', 'cli', 'config.json');
  state.checked.push(path);
  const text = readConfigText(readText, path, state);
  if (text == null) return [];
  const parsed = parseJson(text, path, state);
  const servers = parsed?.mcp?.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const declarations = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (entry && typeof entry === 'object' && entry.enabled === false) continue;
    declarations.push({ name, entry, source: path });
  }
  return declarations;
}

/** 从一行 YAML 里取标量值；引用/无引号都支持，取不到返回 null（不猜）。 */
function yamlScalar(line, key) {
  const pattern = new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([^\\s,}#]+))`);
  const match = pattern.exec(line);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * 从 DSH profile patch YAML 里扫出 @deepseek-ai/dsh-mcp-client 声明块。
 * 没有 YAML 依赖，按缩进块做容错扫描：块首=含插件名的非注释行，块延续到缩进变浅或同级新条目。
 */
function scanDshPluginBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes(DSH_MCP_CLIENT_PLUGIN)) continue;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) continue;
    const baseIndent = line.length - trimmed.length;
    const block = { line: index + 1, lines: [line] };
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor];
      const nextTrimmed = next.trimStart();
      if (!nextTrimmed || nextTrimmed.startsWith('#')) { block.lines.push(next); continue; }
      const indent = next.length - nextTrimmed.length;
      if (indent < baseIndent) break;
      if (indent === baseIndent && nextTrimmed.startsWith('- ')) break;
      block.lines.push(next);
    }
    blocks.push(block);
    index += block.lines.length - 1;
  }
  return blocks;
}

/** DSH：headless profile 用户 patch 层会随 headless 启动继承；只读这里，不改用户配置。 */
function collectDshDeclarations({ home, env, dshProfile, dshHome: configuredDshHome }, readText, state) {
  const dshHome = typeof configuredDshHome === 'string' && configuredDshHome
    ? configuredDshHome
    : typeof env?.DSH_HOME === 'string' && env.DSH_HOME
      ? env.DSH_HOME
      : (typeof home === 'string' && home ? join(home, '.dsh') : null);
  if (!dshHome) return [];
  const profile = typeof dshProfile === 'string' && dshProfile ? dshProfile : DSH_PROBE_PROFILE;
  const path = join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  state.checked.push(path);
  const text = readConfigText(readText, path, state);
  if (text == null) return [];
  const declarations = [];
  for (const block of scanDshPluginBlocks(text)) {
    const values = {};
    for (const line of block.lines) {
      for (const key of DSH_BLOCK_KEYS) {
        if (values[key] !== undefined) continue;
        const value = yamlScalar(line, key);
        if (value !== null) values[key] = value;
      }
    }
    const name = values.serverName ?? null;
    const disabled = values.disabled === 'true' || values.enabled === 'false';
    if (disabled) continue;
    if (typeof name !== 'string' || !DSH_SERVER_NAME.test(name)) { state.notes.push(`${path}:${block.line}：无法解析 serverName 的 MCP 客户端声明`); continue; }
    const entry = {
      ...(values.transport ? { type: values.transport } : {}),
      ...(values.url ? { url: values.url } : {}),
      ...(values.command ? { command: values.command } : {}),
    };
    declarations.push({ name, entry, source: `${path}:${block.line}` });
  }
  return declarations;
}

/** 逐条声明求值：只有 stdio 且 command 真实可执行才算 verified。 */
function evaluateDeclaration(declaration, resolveCommand, state) {
  const { name, entry, source } = declaration;
  if (!state.withinDeadline()) return null;
  if (looksHttp(entry)) {
    return { name, source, verified: false, detail: 'HTTP/SSE 声明无法在启动前同步确认可用' };
  }
  if (entry && typeof entry === 'object' && typeof entry.type === 'string' && !['stdio'].includes(entry.type.toLowerCase())) {
    return { name, source, verified: false, detail: `未支持的 transport: ${entry.type}` };
  }
  const config = stdioConfig(entry);
  if (!config) return { name, source, verified: false, detail: '声明缺少可克隆的 stdio command/args/env' };
  const executable = resolveCommand(config.command);
  if (!executable) return { name, source, verified: false, detail: `stdio command 不在 PATH 或不可执行: ${config.command}` };
  return { name, source, verified: true, detail: `command 可执行: ${executable}`, config };
}

function unavailableReason(host, state, declarations, evaluated, deadlineMs) {
  if (state.timedOut) {
    return `${hostLabel(host)}：${BROWSER_MCP_UNAVAILABLE_REASON}（探测超过 ${deadlineMs}ms，已停止读取剩余配置）`;
  }
  const parts = [];
  if (evaluated.length) {
    parts.push(evaluated.map(candidate => `${candidate.name}（${candidate.detail}）`).join('、'));
  } else {
    const names = declarations.map(item => item.name).filter(name => typeof name === 'string' && name);
    parts.push(names.length
      ? `已检查 ${state.checked.join('、')}；MCP 声明均不在浏览器名称白名单（${names.slice(0, 5).join('、')}）`
      : `已检查 ${state.checked.length ? state.checked.join('、') : '0 个配置文件'}；未发现浏览器 MCP 声明`);
  }
  if (state.notes.length) parts.push(`读取异常：${state.notes.join('；')}`);
  return `${hostLabel(host)}：${BROWSER_MCP_UNAVAILABLE_REASON}（${parts.join('；')}）`;
}

/**
 * 探测宿主配置里真实存在且本轮可放行的浏览器 MCP。
 * 返回 { host, servers, candidates, checked, reason }；servers 非空时 reason=null。
 * 永不抛错：未知宿主/读取异常/超时都返回空 servers 与说明性 reason。
 */
export function probeBrowserMcpServers({
  host,
  configDirectory,
  home = homedir(),
  env = process.env,
  dshHome,
  dshProfile = DSH_PROBE_PROFILE,
  now = Date.now,
  deadlineMs = BROWSER_MCP_PROBE_DEADLINE_MS,
  readText = defaultReadText,
  resolveCommand = resolveHostCommand,
} = {}) {
  const state = createState({ now, deadlineMs, notes: [] });
  const collect = host === 'claude'
    ? () => collectClaudeDeclarations({ configDirectory, home }, readText, state)
    : host === 'zcode'
      ? () => collectZcodeDeclarations({ home }, readText, state)
      : host === 'dsh'
        ? () => collectDshDeclarations({ home, env, dshProfile, dshHome }, readText, state)
        : null;
  if (!collect) {
    return {
      host, servers: [], candidates: [], checked: [],
      reason: `${hostLabel(host)}：${BROWSER_MCP_UNAVAILABLE_REASON}（未知宿主，未读取任何配置）`,
    };
  }
  const declarations = collect();
  const browserDeclarations = declarations.filter(declaration => isBrowserMcpServer(declaration.name) && declaration.name !== 'agent_team');
  const candidates = [];
  const servers = [];
  const accepted = new Set();
  for (const declaration of browserDeclarations) {
    const candidate = evaluateDeclaration(declaration, resolveCommand, state);
    if (!candidate) continue;
    candidates.push(candidate);
    if (!candidate.verified || accepted.has(candidate.name)) continue;
    accepted.add(candidate.name);
    servers.push({ name: candidate.name, config: candidate.config });
  }
  return {
    host,
    servers,
    candidates,
    checked: state.checked,
    timedOut: state.timedOut,
    reason: servers.length ? null : unavailableReason(host, state, declarations, candidates, deadlineMs),
  };
}

/**
 * 归一化探测结果（含注入的 browserProbe 假函数）：形状非法/异常一律退化为不可用，绝不抛错。
 * 适配器在 executionCapabilities（需同步）与 run 的启动配置生成处共用它。
 */
export function normalizeBrowserProbeResult(result) {
  try {
    const servers = Array.isArray(result?.servers)
      ? result.servers.filter(server => server
        && typeof server.name === 'string' && server.name
        && server.config && typeof server.config === 'object'
        && typeof server.config.command === 'string' && server.config.command)
      : [];
    if (servers.length) return { servers, reason: null };
    return {
      servers: [],
      reason: typeof result?.reason === 'string' && result.reason ? result.reason : BROWSER_MCP_UNAVAILABLE_REASON,
    };
  } catch {
    return { servers: [], reason: BROWSER_MCP_UNAVAILABLE_REASON };
  }
}
