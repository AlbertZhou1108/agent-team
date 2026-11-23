// 成员执行能力裁剪：四宿主差异由 traits 表达，公共分支只有一份实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { memberExecutionCapabilities, browserToolCapability } from '../../hosts/execution.mjs';
import { createCodexHost, CODEX_TRAITS } from '../../member/codex/index.mjs';
import { createClaudeHost, CLAUDE_TRAITS } from '../../member/claude/index.mjs';
import { createDshHost, DSH_TRAITS } from '../../member/dsh/index.mjs';
import { createZcodeHost, ZCODE_TRAITS } from '../../member/zcode/index.mjs';

const FULL = ['exec.read', 'exec.write'];

test('communication never yields execution capabilities', () => {
  for (const traits of [{}, CODEX_TRAITS, CLAUDE_TRAITS]) {
    const result = memberExecutionCapabilities(traits, { mode: 'communication', allowShell: true });
    assert.equal(result.effectivePolicy, 'communication');
    assert.deepEqual(result.capabilities, []);
  }
});

test('read-only exposes read, and only codex keeps a read-only shell', () => {
  const codex = memberExecutionCapabilities(CODEX_TRAITS, { mode: 'read-only', allowShell: true });
  assert.equal(codex.effectivePolicy, 'read-only');
  assert.deepEqual(codex.capabilities, ['exec.read', 'exec.shell']);
  assert.match(codex.reason, /只读沙箱/);

  for (const traits of [DSH_TRAITS, ZCODE_TRAITS, CLAUDE_TRAITS]) {
    const result = memberExecutionCapabilities(traits, { mode: 'read-only', allowShell: true });
    assert.deepEqual(result.capabilities, ['exec.read']);
    assert.equal(result.reason, '群策略只允许读取');
  }
});

test('codex degrades the whole class to communication without shell', () => {
  const result = memberExecutionCapabilities(CODEX_TRAITS, { mode: 'workspace-write', allowShell: false });
  assert.equal(result.effectivePolicy, 'communication');
  assert.deepEqual(result.capabilities, []);
  assert.match(result.reason, /未启用 shell/);
});

test('workspace-write keeps files, and shell follows allowShell', () => {
  for (const traits of [DSH_TRAITS, ZCODE_TRAITS]) {
    const withShell = memberExecutionCapabilities(traits, { mode: 'workspace-write', allowShell: true });
    assert.equal(withShell.effectivePolicy, 'workspace-write');
    assert.deepEqual(withShell.capabilities, [...FULL, 'exec.shell']);
    assert.equal(withShell.reason, null);

    const withoutShell = memberExecutionCapabilities(traits, { mode: 'workspace-write', allowShell: false });
    assert.deepEqual(withoutShell.capabilities, FULL);
  }
});

test('zcode explains a shell-less workspace-write differently', () => {
  const result = memberExecutionCapabilities(ZCODE_TRAITS, { mode: 'workspace-write', allowShell: false });
  assert.equal(result.reason, '未启用 shell；执行边界依赖 ZCode 会话权限模式');
});

test('claude on windows degrades to read-only', () => {
  const win = memberExecutionCapabilities(CLAUDE_TRAITS, { mode: 'workspace-write', allowShell: true, platform: 'win32' });
  assert.equal(win.effectivePolicy, 'read-only');
  assert.deepEqual(win.capabilities, ['exec.read']);
  assert.match(win.reason, /Windows/);

  const mac = memberExecutionCapabilities(CLAUDE_TRAITS, { mode: 'workspace-write', allowShell: true, platform: 'darwin' });
  assert.equal(mac.effectivePolicy, 'workspace-write');
  assert.deepEqual(mac.capabilities, [...FULL, 'exec.shell']);
});

test('read-only is checked before the platform boundary trait', () => {
  const result = memberExecutionCapabilities(CLAUDE_TRAITS, { mode: 'read-only', allowShell: false, platform: 'win32' });
  assert.equal(result.effectivePolicy, 'read-only');
  assert.equal(result.reason, '群策略只允许读取');
});

test('browser capability comes only from a real host report and respects authorization', () => {
  // 未授权、通信策略、宿主未报告可用都保持 false，并给出可读原因。
  assert.deepEqual(browserToolCapability({ effectivePolicy: 'communication', requested: true, supported: true }), {
    toolBrowser: false, browserReason: 'communication 策略下浏览器/Computer Use 工具一律禁用',
  });
  assert.equal(browserToolCapability({ effectivePolicy: 'workspace-write', requested: false, supported: true }).toolBrowser, false);
  assert.match(browserToolCapability({ effectivePolicy: 'workspace-write', requested: true, supported: false }).browserReason, /未检测到可用/);
  assert.match(browserToolCapability({ effectivePolicy: 'workspace-write', requested: true, supported: false, reason: '当前受控启动配置仅挂载 agent_team MCP' }).browserReason, /仅挂载 agent_team/);
  assert.deepEqual(browserToolCapability({ effectivePolicy: 'workspace-write', requested: true, supported: true }), {
    toolBrowser: true, browserReason: null,
  });
});

test('codex reports native browser access only when the member policy authorizes it', () => {
  const host = createCodexHost({ command: 'codex' });
  const authorized = host.executionCapabilities({ mode: 'workspace-write', allowShell: true, allowBrowser: true });
  assert.equal(authorized.toolBrowser, true);
  assert.equal(authorized.browserReason, null);
  const unauthorized = host.executionCapabilities({ mode: 'workspace-write', allowShell: true });
  assert.equal(unauthorized.toolBrowser, false);
  assert.match(unauthorized.browserReason, /allowBrowser/);
  const communication = host.executionCapabilities({ mode: 'communication', allowShell: false, allowBrowser: true });
  assert.equal(communication.toolBrowser, false);
  assert.match(communication.browserReason, /communication/);
});

const BROWSER_SERVER = { name: 'playwright', config: { command: 'npx', args: ['@playwright/mcp'] } };

/** 三家无原生浏览器开关的宿主：探测结果只能来自注入的 browserProbe，单元测试不读真实用户配置。 */
function probedHosts(browserProbe) {
  return [
    ['claude', createClaudeHost({ command: 'claude', browserProbe })],
    ['dsh', createDshHost({ command: 'dsh', browserProbe })],
    ['zcode', createZcodeHost({ command: 'zcode', browserProbe })],
  ];
}

test('claude/dsh/zcode report browser access only when the probe finds a real browser MCP', () => {
  let calls = 0;
  const browserProbe = () => { calls += 1; return { servers: [BROWSER_SERVER], reason: null }; };
  for (const [name, host] of probedHosts(browserProbe)) {
    calls = 0;
    const authorized = host.executionCapabilities({ mode: 'workspace-write', allowShell: true, allowBrowser: true });
    assert.equal(authorized.toolBrowser, true, name);
    assert.equal(authorized.browserReason, null, name);
    assert.equal(calls, 1, name);

    calls = 0;
    const unauthorized = host.executionCapabilities({ mode: 'workspace-write', allowShell: true });
    assert.equal(unauthorized.toolBrowser, false, name);
    assert.match(unauthorized.browserReason, /allowBrowser=false/, name);
    assert.equal(calls, 0, name);

    const communication = host.executionCapabilities({ mode: 'communication', allowShell: false, allowBrowser: true });
    assert.equal(communication.toolBrowser, false, name);
    assert.match(communication.browserReason, /communication/, name);
    assert.equal(calls, 0, name);
  }
});

test('claude/dsh/zcode keep browser false and pass through the probe reason', () => {
  const browserProbe = () => ({ servers: [], reason: '已开启授权，但未发现浏览器 MCP' });
  for (const [name, host] of probedHosts(browserProbe)) {
    const result = host.executionCapabilities({ mode: 'read-only', allowShell: false, allowBrowser: true });
    assert.equal(result.toolBrowser, false, name);
    assert.equal(result.browserReason, '已开启授权，但未发现浏览器 MCP', name);
  }
});

test('a throwing probe degrades to false instead of breaking capability cards', () => {
  const browserProbe = () => { throw new Error('boom'); };
  for (const [name, host] of probedHosts(browserProbe)) {
    const result = host.executionCapabilities({ mode: 'workspace-write', allowShell: true, allowBrowser: true });
    assert.equal(result.toolBrowser, false, name);
    assert.match(result.browserReason, /探测异常：boom/, name);
  }
});

