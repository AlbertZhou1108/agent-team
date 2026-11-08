#!/usr/bin/env node
import { version } from './version.mjs';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { startServer, socketFor } from './server.mjs';
import { rpc, serveMcp, serveControlMcp } from './rpc.mjs';
import { Store } from './store.mjs';
import { createExternalIdentity } from './control-plane.mjs';
import { CONTROL_CAPABILITIES, CONTROL_PROTOCOL_VERSION, CONTROLLER_REQUIRED_CAPABILITIES } from './control-capabilities.mjs';
import { nodeRunner } from './runtime.mjs';
import { defaultSkillTarget, installSkill } from './skill-install.mjs';

const options = {
  data: { type: 'string', default: 'work/local' }, port: { type: 'string', default: '0' },
  name: { type: 'string', default: '我的 Agent 群' }, workspace: { type: 'string', default: process.cwd() },
  lead: { type: 'string', default: 'codex' }, members: { type: 'string', default: '' },
  group: { type: 'string' }, host: { type: 'string' }, member: { type: 'string' }, text: { type: 'string' },
  hosts: { type: 'string' }, socket: { type: 'string' }, endpoint: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  charter: { type: 'string' }, policy: { type: 'string' }, reason: { type: 'string' }, turn: { type: 'string' },
  client: { type: 'string' }, principal: { type: 'string' }, session: { type: 'string' },
  capabilities: { type: 'string' }, command: { type: 'string' },
  'skill-root': { type: 'string' }, 'no-install-skill': { type: 'boolean' },
};
export function parseMembers(text = '') {
  return text ? text.split(',').filter(Boolean).map(item => {
    const [name, host, ...extra] = item.trim().split('=');
    if (!name || !host || extra.length) throw new Error('成员格式：名称=宿主，用逗号分隔');
    return { name, host };
  }) : [];
}
async function main() {
  const { values, positionals } = parseArgs({ options, allowPositionals: true });
  const command = positionals[0] ?? 'start';
  if (values.help) return console.log(`agent-team — 本机 CLI Agent 群（Node >=22.13）

直接创建群并进入对话：
  npm start -- --lead codex --members 配色=dsh,质感=claude --workspace /项目目录
继续已有群：
  npm start -- --group 群编号

命令：start / serve / connect / bind-session / mcp / models / new / chat / groups / members / state / direct / archive / restore / resolve-runtime / add / remove / delete / retry / stop
  connect           登记外部主控 client binding，并输出 stdio MCP 配置
  bind-session      用 AGENT_TEAM_CLIENT_KEY 把宿主 thread/session 绑定到 client
  new               在已有总线上创建新群（--charter 可选团队说明文件）
  state             查看群沟通状态与待核实运行
  direct 文本       向团队调度会话发送一条明确共享的用户指令
  archive / restore 归档或恢复群；归档后停止投递，可随时恢复
  --data 目录       本地数据（默认 work/local）
  --port 端口       面板端口，默认随机
  --hosts 文件      CLI 宿主别名及适配器配置
  --charter 文件    建群时的团队说明（纯文本，注入各回合上下文，不构成授权门禁）
  --policy 策略     communication | read-only | workspace-write（默认 workspace-write）
  --group 编号      操作的群
  --text 文本       chat 单次私聊（先运行 serve）
  --member 名称     remove / stop 的成员
  --client 名称     外部主控连接名称（connect）
  --principal 名称  外部主控身份名称，默认本机用户
  --session ID      外部宿主稳定 session 标识
  --capabilities    逗号分隔的主控能力 ID；默认使用成为主控所需的最小能力
  --command 路径    主动唤醒使用的宿主命令，默认与 --host 相同
  --skill-root 目录 覆盖 Skill 安装目录
  --no-install-skill 只登记连接，不安装或更新 Skill

聊天中：/members /add 名称=宿主 /remove 名称 /stop 名称 /retry /groups /use 群编号 /archive /restore /delete /quit
普通输入只发给主 Agent，不进入群记录。Ctrl+C 停止当前总线；群配置与消息保留。
主 Agent 和成员使用宿主现有认证。请先登录相应 CLI。`);
  const directory = resolve(values.data);
  if (command === 'mcp') {
    if (values.client) return serveControlMcp(values.socket ?? socketFor(directory), values.client, process.env.AGENT_TEAM_CLIENT_KEY);
    return serveMcp(values.socket, values.endpoint, process.env.AGENT_TEAM_KEY, process.env.AGENT_TEAM_TURN);
  }
  const socketPath = socketFor(directory);
  const groupArgs = () => ({
    name: values.name,
    workspace: values.workspace,
    charter: values.charter ? readFileSync(resolve(values.charter), 'utf8') : undefined,
    policy: values.policy,
    lead: { name: '主 Agent', host: values.lead },
    members: parseMembers(values.members),
  });
  if (command === 'connect') {
    const host = values.host;
    const client = values.client;
    if (!host || !client) throw new Error('connect 需要 --host 与 --client');
    const capabilityIds = values.capabilities
      ? values.capabilities.split(',').map(item => item.trim()).filter(Boolean)
      : [
          ...CONTROLLER_REQUIRED_CAPABILITIES,
          ...(host === 'codex' ? [CONTROL_CAPABILITIES.sessionWake] : []),
        ];
    const required = new Set(CONTROLLER_REQUIRED_CAPABILITIES);
    if ([...required].some(capability => !capabilityIds.includes(capability))) {
      throw new Error(`外部主控至少需要能力: ${[...required].join(', ')}`);
    }
    const store = new Store(directory);
    try {
      let installedSkill = null;
      if (!values['no-install-skill']) {
        const targetDir = values['skill-root'] || defaultSkillTarget(host);
        if (targetDir) {
          installedSkill = installSkill({
            sourceDir: fileURLToPath(new URL('../skills/agent-team', import.meta.url)),
            targetDir,
            version,
            protocolVersion: CONTROL_PROTOCOL_VERSION,
          });
        } else {
          installedSkill = {
            installed: false,
            current: false,
            reason: `未知宿主的 Skill 目录；请用 --skill-root 指定，或加 --no-install-skill`,
          };
        }
      }
      const identity = createExternalIdentity(store, {
        principalName: values.principal,
        bindingName: client,
        host,
        command: values.command ?? host,
        session: values.session ?? null,
        declared: {
          capabilities: capabilityIds,
          workspaceRoots: [resolve(values.workspace)],
          policies: ['communication', 'read-only', 'workspace-write'],
        },
        probed: {
          capabilities: capabilityIds,
          workspaceRoots: [resolve(values.workspace)],
          policies: ['communication', 'read-only', 'workspace-write'],
        },
      });
      const runner = nodeRunner();
      const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
      console.log(JSON.stringify({
        principal: identity.principal,
        binding: {
          id: identity.binding.id,
          name: identity.binding.name,
          host: identity.binding.host,
          session: identity.binding.session,
        },
        capabilities: identity.capabilities,
        skill: installedSkill,
        mcp: {
          agent_team: {
            command: runner.command,
            args: ['--disable-warning=ExperimentalWarning', cli, 'mcp', '--socket', socketPath, '--client', identity.binding.id],
            env: {
              ...runner.env,
              AGENT_TEAM_CLIENT_KEY: identity.key,
              AGENT_TEAM_CONTROL_PROTOCOL: String(CONTROL_PROTOCOL_VERSION),
            },
          },
        },
      }, null, 2));
    } finally {
      store.close();
    }
    return;
  }
  if (command !== 'start' && command !== 'serve') {
    let request;
    if (command === 'new') request = { op: 'new', args: groupArgs() };
    else if (command === 'groups') request = { op: 'groups' };
    else if (command === 'models') request = { op: 'model_catalog', refresh: true };
    else if (command === 'bind-session') request = {
      op: 'bind_client_session',
      binding: values.client,
      key: process.env.AGENT_TEAM_CLIENT_KEY,
      session: values.session,
      protocolVersion: Number(process.env.AGENT_TEAM_CONTROL_PROTOCOL) || null,
    };
    else if (command === 'chat' && values.text) request = { op: 'chat', group: values.group, text: values.text };
    else if (command === 'chat') return interactive(socketPath, values.group);
    else if (command === 'members') request = { op: 'members', group: values.group };
    else if (command === 'state') request = { op: 'collaboration', group: values.group };
    else if (command === 'direct') request = { op: 'directive', group: values.group, text: values.text };
    else if (command === 'archive' || command === 'restore') request = { op: command, group: values.group };
    else if (command === 'resolve-runtime') request = { op: 'resolve_runtime', group: values.group, turn: values.turn, reason: values.reason };
    else if (command === 'reset-session') request = { op: 'reset_session', endpoint: values.endpoint, reason: values.reason };
    else if (command === 'add') request = { op: 'add', group: values.group, args: { name: values.member, host: values.host } };
    else if (['remove', 'stop'].includes(command)) request = { op: command, group: values.group, member: values.member };
    else if (['retry', 'delete'].includes(command)) request = { op: command, group: values.group };
    else throw new Error('未知命令，使用 --help 查看');
    console.log(JSON.stringify(await rpc(socketPath, request), null, 2));
    return;
  }
  let readline;
  if (command === 'start') readline = createInterface({ input: stdin, output: stdout });
  const server = await startServer({ directory, port: Number(values.port), configFile: values.hosts });
  console.log(`Agent Team ${version}\n面板：${server.url}\n数据目录：${directory}`);
  server.bus.on('notice', notice => stderr.write(`\n[系统通知] ${notice.text}\n`));
  let shuttingDown;
  const shutdown = () => shuttingDown ??= (async () => { readline?.close(); await server.close(); })();
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  if (command === 'serve') return;
  try {
    const group = values.group ? server.bus.store.group(values.group) : await server.bus.createGroup(groupArgs());
    console.log(`群：${group.name} (${group.id})\n成员入群会自述能力。直接输入与主 Agent 聊天；/help 查看本地命令。`);
    await interactive(socketPath, group.id, readline);
  } finally { await shutdown(); }
}

async function interactive(socketPath, initialGroup, existing) {
  const readline = existing ?? createInterface({ input: stdin, output: stdout });
  let group = initialGroup;
  try {
    if (!group) throw new Error('需要 --group 群编号');
    while (!readline.closed) {
      let line;
      try { line = (await readline.question('\n你 > ')).trim(); } catch { break; }
      if (!line) continue;
      if (line === '/quit') break;
      try {
        let request;
        if (line === '/help') { console.log('/state /direct 文本 /resolve 运行ID 核实依据 /members /add 名称=宿主 /remove 名称 /stop 名称 /retry /groups /use 群编号 /archive /restore /delete /quit'); continue; }
        if (line.startsWith('/use ')) { group = line.slice(5).trim(); console.log(await rpc(socketPath, { op: 'members', group })); continue; }
        if (line === '/members') request = { op: 'members', group };
        else if (line === '/state') request = { op: 'collaboration', group };
        else if (line.startsWith('/direct ')) request = { op: 'directive', group, text: line.slice(8).trim() };
        else if (line === '/archive') {
          if (!/^y(es)?$/i.test((await readline.question('归档本群？归档后停止消息投递，可随时 /restore 恢复。[y/N] ')).trim())) continue;
          request = { op: 'archive', group };
        }
        else if (line === '/restore') request = { op: 'restore', group };
        else if (line.startsWith('/resolve ')) { const [turn, ...reason] = line.slice(9).trim().split(/\s+/); request = { op: 'resolve_runtime', group, turn, reason: reason.join(' ') }; }
        else if (line === '/groups') request = { op: 'groups' };
        else if (line === '/retry') request = { op: 'retry', group };
        else if (line.startsWith('/add ')) request = { op: 'add', group, args: parseMembers(line.slice(5))[0] };
        else if (line.startsWith('/remove ')) request = { op: 'remove', group, member: line.slice(8).trim() };
        else if (line.startsWith('/stop ')) request = { op: 'stop', group, member: line.slice(6).trim() };
        else if (line === '/delete') {
          if (!/^y(es)?$/i.test((await readline.question('删除本群配置与记录？宿主历史不会删除。[y/N] ')).trim())) continue;
          console.log(await rpc(socketPath, { op: 'delete', group })); break;
        } else if (line.startsWith('/')) throw new Error('未知本地命令');
        else request = { op: 'chat', group, text: line };
        readline.agentTeamBusy = true;
        let result;
        try { result = await rpc(socketPath, request); }
        finally { readline.agentTeamBusy = false; }
        console.log(typeof result === 'string' ? `\n主 Agent > ${result}` : JSON.stringify(result, null, 2));
      } catch (error) { stderr.write(`\n${error.message}\n`); }
    }
  } finally { if (!existing) readline.close(); }
}

main().catch(error => { stderr.write(`agent-team: ${error.message}\n`); process.exitCode = 1; });
