import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeRunner } from '../../runtime.mjs';
import { mcpConfig } from '../../hosts/process.mjs';

test('普通 Node 运行时不注入 Electron 标记', () => {
  assert.deepEqual(nodeRunner({ execPath: '/usr/bin/node', electron: false }), {
    command: '/usr/bin/node', env: {},
  });
});

test('Electron 运行时沿用同一个可执行文件并声明以 Node 模式启动', () => {
  const app = '/Applications/Agent Team.app/Contents/MacOS/Agent Team';
  assert.deepEqual(nodeRunner({ execPath: app, electron: true }), {
    command: app, env: { ELECTRON_RUN_AS_NODE: '1' },
  });
});

const endpoint = { id: 'endpoint-1', key: 'secret-key' };

test('MCP 启动命令在 Electron 下把 Node 模式声明写进宿主配置', () => {
  const app = '/Applications/Agent Team.app/Contents/MacOS/Agent Team';
  const config = mcpConfig({
    socketPath: '/data/bus.sock',
    endpoint,
    turnId: 'turn-1',
    runner: nodeRunner({ execPath: app, electron: true }),
    cli: '/app/src/cli.mjs',
  });
  assert.equal(config.command, app);
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(config.env.AGENT_TEAM_KEY, 'secret-key');
  assert.equal(config.env.AGENT_TEAM_TURN, 'turn-1');
  assert.deepEqual(config.args.slice(-4), ['--socket', '/data/bus.sock', '--endpoint', 'endpoint-1']);
});

test('MCP 启动命令在普通 Node 下保持原有形态', () => {
  const config = mcpConfig({
    socketPath: '/data/bus.sock',
    endpoint,
    turnId: 'turn-1',
    runner: nodeRunner({ execPath: '/usr/bin/node', electron: false }),
    cli: '/app/src/cli.mjs',
  });
  assert.equal(config.command, '/usr/bin/node');
  assert.deepEqual(config.env, { AGENT_TEAM_KEY: 'secret-key', AGENT_TEAM_TURN: 'turn-1' });
});
