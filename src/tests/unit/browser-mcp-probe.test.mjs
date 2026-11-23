// 非 Codex 宿主浏览器 MCP 实查探测：只读、可超时、绝不抛错；未命中一律保守 false。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  BROWSER_MCP_UNAVAILABLE_REASON,
  normalizeBrowserProbeResult,
  probeBrowserMcpServers,
  resolveHostCommand,
} from '../../hosts/browser-mcp-probe.mjs';
import { claudeMcpAllowRule, claudeExecutionConfig, dshMcpToolPrefix } from '../../hosts/policies.mjs';
import { claudeMcpServersConfig } from '../../host-runtime/process.mjs';
import { zcodeMcpConfig, trustAgentTeamServer, trustWorkspaceMcpServers } from '../../member/zcode/index.mjs';
import { apply as applyDshPolicy } from '../../member/dsh/policy.mjs';

const HOME = '/home/tester';
const CONFIG_DIR = '/conf/claude';
const claudeConfigPath = join(CONFIG_DIR, '.claude.json');
const claudeHomePath = join(HOME, '.claude.json');
const zcodeConfigPath = join(HOME, '.zcode', 'cli', 'config.json');
const dshConfigPath = join(HOME, '.dsh', 'profiles', 'headless', 'cordis.patch.yml');

function jsonServers(servers) {
  return JSON.stringify({ mcpServers: servers });
}

function zcodeServers(servers) {
  return JSON.stringify({ mcp: { servers } });
}

/** 内存里监听固定路径的 readText；未登记路径按 ENOENT（正常未配置）。 */
function reader(files) {
  return path => {
    if (path in files) return files[path];
    const error = new Error('missing ' + path);
    error.code = 'ENOENT';
    throw error;
  };
}

function probeClaude(files, options = {}) {
  return probeBrowserMcpServers({
    host: 'claude',
    configDirectory: CONFIG_DIR,
    home: HOME,
    readText: reader(files),
    resolveCommand: options.resolveCommand ?? (command => (command === 'npx' ? '/usr/local/bin/npx' : null)),
    ...(options.now ? { now: options.now } : {}),
    ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
  });
}

function probeZcode(files, options = {}) {
  return probeBrowserMcpServers({
    host: 'zcode',
    home: HOME,
    readText: reader(files),
    resolveCommand: options.resolveCommand ?? (command => (command === 'npx' ? '/usr/local/bin/npx' : null)),
    ...(options.now ? { now: options.now } : {}),
  });
}

function probeDsh(files, options = {}) {
  return probeBrowserMcpServers({
    host: 'dsh',
    home: HOME,
    dshHome: join(HOME, '.dsh'),
    readText: reader(files),
    resolveCommand: options.resolveCommand ?? (command => (command === 'npx' ? '/usr/local/bin/npx' : null)),
    ...(options.now ? { now: options.now } : {}),
  });
}

test('claude: a declared and executable browser MCP is detected', () => {
  const result = probeClaude({
    [claudeHomePath]: jsonServers({
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp'], env: { PLAYWRIGHT_BROWSERS_PATH: '/cache' } },
      webstorm: { type: 'http', url: 'http://127.0.0.1:64542/stream' },
    }),
  });
  assert.deepEqual(result.servers, [{
    name: 'playwright',
    config: { command: 'npx', args: ['-y', '@playwright/mcp'], env: { PLAYWRIGHT_BROWSERS_PATH: '/cache' } },
  }]);
  assert.equal(result.reason, null);
  assert.deepEqual(result.checked.sort(), [claudeConfigPath, claudeHomePath].sort());
  assert.equal(result.timedOut, false);
});

test('claude: config directory takes precedence and duplicate server names are deduped', () => {
  const result = probeClaude({
    [claudeConfigPath]: jsonServers({ playwright: { command: 'npx', args: ['first'] } }),
    [claudeHomePath]: jsonServers({ playwright: { command: 'npx', args: ['second'] } }),
  });
  assert.equal(result.servers.length, 1);
  assert.deepEqual(result.servers[0].config.args, ['first']);
});

test('claude: a browser-named MCP whose command is missing stays unavailable with a reason', () => {
  const result = probeClaude({ [claudeHomePath]: jsonServers({ browser: { command: 'missing-browser' } }) });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, new RegExp(BROWSER_MCP_UNAVAILABLE_REASON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.reason, /不在 PATH 或不可执行: missing-browser/);
});

test('claude: HTTP browser MCP declarations are never reported as usable', () => {
  const result = probeClaude({ [claudeHomePath]: jsonServers({ playwright: { type: 'http', url: 'http://127.0.0.1:1234/mcp' } }) });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /HTTP\/SSE 声明无法在启动前同步确认可用/);
});

test('claude: non-browser MCP declarations are reported by name, not guessed into browser capability', () => {
  const result = probeClaude({
    [claudeHomePath]: jsonServers({
      figwright: { command: 'npx', args: ['-y', '@figwright/mcp@latest'] },
      idea: { type: 'http', url: 'http://127.0.0.1:64342/stream' },
    }),
  });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /均不在浏览器名称白名单（figwright、idea）/);
});

test('claude: unreadable config degrades to unavailable instead of throwing', () => {
  const result = probeBrowserMcpServers({
    host: 'claude',
    configDirectory: CONFIG_DIR,
    home: HOME,
    readText: path => {
      const error = new Error('denied ' + path);
      error.code = 'EACCES';
      throw error;
    },
  });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /读取异常：/);
  assert.match(result.reason, /EACCES/);
});

test('claude: probe stops reading once the deadline is exceeded', () => {
  let ticks = 0;
  const result = probeClaude({ [claudeHomePath]: jsonServers({ playwright: { command: 'npx' } }) }, {
    now: () => { ticks += 1000; return ticks; },
    deadlineMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /探测超过 200ms，已停止读取剩余配置/);
});

test('zcode: enabled browser MCP is detected; disabled ones are skipped', () => {
  const result = probeZcode({
    [zcodeConfigPath]: zcodeServers({
      playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
      'computer-use': { type: 'stdio', command: 'npx', enabled: false },
      figwright: { type: 'stdio', command: 'npx', args: ['@figwright/mcp@latest'] },
    }),
  });
  assert.deepEqual(result.servers.map(server => server.name), ['playwright']);
  assert.equal(result.reason, null);
});

test('zcode: only disabled browser declarations yields an unavailable reason', () => {
  const result = probeZcode({
    [zcodeConfigPath]: zcodeServers({ browser: { type: 'stdio', command: 'npx', enabled: false } }),
  });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /未发现浏览器 MCP 声明/);
});

test('zcode: http browser declarations are unverified', () => {
  const result = probeZcode({
    [zcodeConfigPath]: zcodeServers({ 'chrome-devtools': { type: 'http', url: 'http://127.0.0.1:9222/mcp' } }),
  });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /HTTP\/SSE 声明无法在启动前同步确认可用/);
});

test('dsh: headless profile patch declares a stdio browser MCP that is inherited at launch', () => {
  const patch = [
    '- insert:',
    '    - id: mcp-playwright',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: playwright',
    '        transport: stdio',
    '        command: npx',
    '        args:',
    '          - "-y"',
    '          - "@playwright/mcp@latest"',
    '    - id: mcp-figma',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: figwright',
    '        transport: stdio',
    '        command: npx-figma',
  ].join('\n');
  const result = probeDsh({ [dshConfigPath]: patch });
  assert.deepEqual(result.servers, [{ name: 'playwright', config: { command: 'npx' } }]);
  assert.equal(result.reason, null);
});

test('dsh: disabled or http browser declarations never become capability', () => {
  const patch = [
    '- insert:',
    '    - id: mcp-browser',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: browser-tools',
    '        transport: stdio',
    '        command: npx',
    '        disabled: true',
    '    - id: mcp-chrome',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: chrome-devtools',
    '        transport: streamable-http',
    '        url: "http://127.0.0.1:9222/mcp"',
  ].join('\n');
  const result = probeDsh({ [dshConfigPath]: patch });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /HTTP\/SSE 声明无法在启动前同步确认可用/);
});

test('dsh: malformed patch content never throws and is reported as a read note', () => {
  const patch = ['- insert:', '    - name: "@deepseek-ai/dsh-mcp-client"', '      config:', '        command: npx'].join('\n');
  const result = probeDsh({ [dshConfigPath]: patch });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /无法解析 serverName 的 MCP 客户端声明/);
});

test('unknown hosts and malformed config files degrade to unavailable', () => {
  const unknown = probeBrowserMcpServers({ host: 'mystery', home: HOME, readText: reader({}) });
  assert.deepEqual(unknown.servers, []);
  assert.match(unknown.reason, /未知宿主，未读取任何配置/);
  const malformed = probeClaude({ [claudeHomePath]: '{not json' });
  assert.deepEqual(malformed.servers, []);
  assert.match(malformed.reason, /JSON 解析失败/);
});

test('resolveHostCommand only accepts real executables and never throws', () => {
  assert.equal(resolveHostCommand(''), null);
  assert.equal(resolveHostCommand('definitely-not-installed-agent-team', { env: { PATH: '/nonexistent-dir' } }), null);
  assert.equal(resolveHostCommand('/definitely/not/here', { env: {} }), null);
  assert.equal(resolveHostCommand(process.execPath, { env: {} }), process.execPath);
});

test('normalizeBrowserProbeResult filters malformed servers and keeps a reason', () => {
  assert.deepEqual(normalizeBrowserProbeResult(undefined), { servers: [], reason: BROWSER_MCP_UNAVAILABLE_REASON });
  assert.deepEqual(normalizeBrowserProbeResult({ servers: [{ name: 'playwright' }] }), { servers: [], reason: BROWSER_MCP_UNAVAILABLE_REASON });
  assert.deepEqual(normalizeBrowserProbeResult(null), { servers: [], reason: BROWSER_MCP_UNAVAILABLE_REASON });
  const server = { name: 'playwright', config: { command: 'npx' } };
  assert.deepEqual(normalizeBrowserProbeResult({ servers: [server], reason: 'ignored' }), { servers: [server], reason: null });
  assert.deepEqual(normalizeBrowserProbeResult({ servers: [], reason: '自定义原因' }), { servers: [], reason: '自定义原因' });
});

test('claude allow rules and dsh tool prefixes reject unsafe server names', () => {
  assert.equal(claudeMcpAllowRule('playwright'), 'mcp__playwright__*');
  assert.equal(dshMcpToolPrefix('playwright'), 'mcp__playwright__');
  for (const name of ['', 'bad/name', 'bad name', null, undefined]) {
    assert.equal(claudeMcpAllowRule(name), null);
    assert.equal(dshMcpToolPrefix(name), null);
  }
});

test('claude execution config widens allow rules only when browser is authorized', () => {
  const authorized = claudeExecutionConfig({ mode: 'read-only', allowShell: true, allowBrowser: true }, [], '/ws', [{ name: 'playwright' }]);
  assert.ok(authorized.allowed.includes('mcp__playwright__*'));
  const unauthorized = claudeExecutionConfig({ mode: 'read-only', allowShell: true, allowBrowser: false }, [], '/ws', [{ name: 'playwright' }]);
  assert.ok(!unauthorized.allowed.includes('mcp__playwright__*'));
  const communication = claudeExecutionConfig({ mode: 'communication', allowShell: false, allowBrowser: false }, [], '/ws', [{ name: 'playwright' }]);
  assert.deepEqual(communication.builtins, []);
  assert.ok(!communication.allowed.includes('mcp__playwright__*'));
});

test('claudeMcpServersConfig keeps agent_team first and skips unsafe browser clones', () => {
  const config = { command: 'node', args: ['cli.mjs'], env: { AGENT_TEAM_KEY: 'k' } };
  const result = claudeMcpServersConfig(config, [
    { name: 'playwright', config: { command: 'npx', args: ['@playwright/mcp'], env: { A: '1' }, cwd: '/work' } },
    { name: 'agent_team', config: { command: 'evil' } },
    { name: 'broken' },
    { name: 'playwright', config: { command: 'npx' } },
  ]);
  assert.deepEqual(Object.keys(result.mcpServers), ['agent_team', 'playwright']);
  assert.deepEqual(result.mcpServers.agent_team, config);
  assert.deepEqual(result.mcpServers.playwright, { command: 'npx', args: ['@playwright/mcp'], env: { A: '1' }, cwd: '/work' });
});

test('zcodeMcpConfig merges browser stdio servers into the isolated HOME config', () => {
  const mcp = { command: 'node', args: ['cli.mjs'], env: { AGENT_TEAM_KEY: 'k' } };
  const result = zcodeMcpConfig(mcp, [
    { name: 'playwright', config: { command: 'npx', args: ['@playwright/mcp'], env: { A: '1' } } },
    { name: 'agent_team', config: { command: 'evil' } },
    { name: 'broken' },
  ]);
  assert.deepEqual(Object.keys(result.mcp.servers), ['agent_team', 'playwright']);
  assert.deepEqual(result.mcp.servers.agent_team, mcp);
  assert.deepEqual(result.mcp.servers.playwright, { type: 'stdio', command: 'npx', args: ['@playwright/mcp'], env: { A: '1' } });
});

/** 触发 DSH agent-team-policy 插件的 agent/created，返回 restrict 收到的精确工具白名单。 */
function runDshPolicy(config, registered) {
  let created;
  applyDshPolicy({ on(event, handler) { if (event === 'agent/created') created = handler; } }, config);
  const restrictions = [];
  created({
    agent: {
      session: { append() {} },
      ctx: {
        tools: {
          definitions: () => registered.map(name => ({ name })),
          get: name => ({ name }),
          restrict: options => restrictions.push(options),
        },
      },
    },
  });
  return restrictions;
}

test('dsh policy allows exactly the registered browser MCP tools and refuses missing servers', () => {
  const restrictions = runDshPolicy({
    mode: 'read-only',
    allowShell: false,
    tools: ['mcp__agent_team__team_read'],
    browserServers: [{ name: 'playwright', toolPrefix: 'mcp__playwright__' }],
  }, ['mcp__agent_team__team_read', 'mcp__playwright__browser_navigate', 'mcp__playwright__browser_click', 'mcp__other__unrelated']);
  assert.deepEqual(restrictions[0].allow.sort(), [
    'glob', 'grep', 'mcp__agent_team__team_read', 'mcp__playwright__browser_click', 'mcp__playwright__browser_navigate', 'read', 'read_image',
  ].sort());
  assert.throws(
    () => runDshPolicy({
      mode: 'read-only',
      allowShell: false,
      tools: ['mcp__agent_team__team_read'],
      browserServers: [{ name: 'playwright', toolPrefix: 'mcp__playwright__' }],
    }, ['mcp__agent_team__team_read']),
    /浏览器 MCP 工具尚未加载，拒绝启动任务：playwright/,
  );
});

test('dsh policy keeps its pre-existing allow list when no browser MCP was detected', () => {
  let definitionCalls = 0;
  let created;
  applyDshPolicy({ on(event, handler) { if (event === 'agent/created') created = handler; } }, {
    mode: 'read-only', allowShell: false, tools: ['mcp__agent_team__team_read'],
  });
  const restrictions = [];
  created({
    agent: {
      session: { append() {} },
      ctx: {
        tools: {
          definitions: () => { definitionCalls += 1; return []; },
          get: name => ({ name }),
          restrict: options => restrictions.push(options),
        },
      },
    },
  });
  assert.equal(definitionCalls, 0);
  assert.deepEqual(restrictions[0].allow.sort(), ['glob', 'grep', 'mcp__agent_team__team_read', 'read', 'read_image'].sort());
});

test('dsh policy fails loudly when a detected browser server exposes no tools', () => {
  assert.throws(
    () => runDshPolicy({
      mode: 'workspace-write',
      allowShell: true,
      tools: ['mcp__agent_team__team_read'],
      browserServers: [{ name: 'playwright', toolPrefix: 'mcp__playwright__' }],
    }, ['mcp__agent_team__team_read']),
    /浏览器 MCP 工具尚未加载/,
  );
});

/** 记录请求顺序与载荷的 fake ZCode 协议，覆盖授信矩阵。 */
function fakeZcodeProtocol(statuses, responses = {}) {
  const requests = [];
  return {
    requests,
    async request(method, payload) {
      requests.push({ method, payload });
      if (method === 'mcp/list') return { statuses };
      if (method === 'workspace/mcp/trust') {
        const key = payload.serverName;
        return responses[key] ?? { accepted: true };
      }
      throw new Error('unexpected request ' + method);
    },
  };
}

test('trustWorkspaceMcpServers requires agent_team and trusts only untrusted digest servers', async () => {
  const protocol = fakeZcodeProtocol({
    agent_team: { workspaceTrust: { declarationDigest: 'digest-team', trusted: false } },
    playwright: { workspaceTrust: { declarationDigest: 'digest-browser', trusted: false } },
    trusted: { workspaceTrust: { declarationDigest: 'digest-trusted', trusted: true } },
    noDigest: { workspaceTrust: {} },
  });
  await trustWorkspaceMcpServers(protocol, { workspacePath: '/ws' }, ['agent_team', 'playwright', 'trusted', 'noDigest']);
  assert.deepEqual(protocol.requests.map(request => request.method), ['mcp/list', 'workspace/mcp/trust', 'workspace/mcp/trust']);
  assert.deepEqual(protocol.requests[1].payload, { workspace: { workspacePath: '/ws' }, serverName: 'agent_team', declarationDigest: 'digest-team', trusted: true });
  assert.deepEqual(protocol.requests[2].payload.serverName, 'playwright');
});

test('trustWorkspaceMcpServers fails loudly for missing servers and rejected trust', async () => {
  const missingTeam = fakeZcodeProtocol({});
  await assert.rejects(
    trustWorkspaceMcpServers(missingTeam, { workspacePath: '/ws' }, ['agent_team']),
    /ZCode 会话未加载 agent_team MCP server；请检查 endpoint 配置/,
  );
  const missingBrowser = fakeZcodeProtocol({ agent_team: { workspaceTrust: { trusted: true } } });
  await assert.rejects(
    trustWorkspaceMcpServers(missingBrowser, { workspacePath: '/ws' }, ['agent_team', 'playwright']),
    /ZCode 会话未加载 playwright MCP server；请检查宿主配置/,
  );
  const rejected = fakeZcodeProtocol(
    { agent_team: {}, playwright: { workspaceTrust: { declarationDigest: 'd', trusted: false } } },
    { playwright: { accepted: false, reasonCode: 'declaration-mismatch' } },
  );
  await assert.rejects(
    trustWorkspaceMcpServers(rejected, { workspacePath: '/ws' }, ['agent_team', 'playwright']),
    /playwright MCP server 授信失败: declaration-mismatch/,
  );
  const accepted = fakeZcodeProtocol({ agent_team: {} }, { agent_team: { accepted: true } });
  await trustAgentTeamServer(accepted, { workspacePath: '/ws' });
  assert.deepEqual(accepted.requests.map(request => request.method), ['mcp/list']);
});
