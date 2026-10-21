#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { startServer, socketFor } from './server.mjs';
import { rpc, serveMcp } from './rpc.mjs';

const options = {
  data: { type: 'string', default: 'work/local' }, port: { type: 'string', default: '0' },
  name: { type: 'string', default: '我的 Agent 群' }, workspace: { type: 'string', default: process.cwd() },
  lead: { type: 'string', default: 'codex' }, members: { type: 'string', default: '' },
  group: { type: 'string' }, host: { type: 'string' }, member: { type: 'string' }, text: { type: 'string' },
  hosts: { type: 'string' }, socket: { type: 'string' }, endpoint: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  preparation: { type: 'string' }, contract: { type: 'string' }, revision: { type: 'string' }, hash: { type: 'string' },
  request: { type: 'string' }, version: { type: 'string' }, reason: { type: 'string' }, turn: { type: 'string' },
  'model-mode': { type: 'string' }, 'model-rules': { type: 'string' },
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

开始准备，在当前CLI对话明确契约，用户确认后才建群：
  npm start -- --lead codex --members 配色=dsh,质感=claude --workspace /项目目录
继续已有群：
  npm start -- --group 群编号

命令：start / serve / models / prepare / preparation-chat / preparation / propose / approve / chat / groups / members / add / remove / delete / retry / stop
  models             重新探测并输出各宿主的可用模型目录
  prepare --contract 文件.json  载入已整理的契约草案（不会直接建群）
  preparation-chat --preparation 编号 --text 文本  继续建群准备对话
  approve --preparation 编号 --revision 版本 --hash 摘要  展示契约并确认
  state / requests / decide / direct / terminate / reopen / resolve-runtime  团队状态与用户决定
  --data 目录       本地数据（默认 work/local）
  --port 端口       只读面板端口，默认随机
  --hosts 文件      CLI 宿主别名及适配器配置
  --model-mode     模型策略：smart 或 user
  --model-rules    模型策略自然语言规则
  --group 编号      操作的群
  --text 文本       chat 单次私聊（先运行 serve）
  --member 名称     remove / stop 的成员

聊天中：/members /add 名称=宿主 /remove 名称 /stop 名称 /retry /groups /use 群编号 /delete /quit
普通输入只发给主 Agent，不进入群记录。Ctrl+C 停止当前总线；群配置与消息保留。
主 Agent 和成员使用宿主现有认证。请先登录相应 CLI。`);
  const directory = resolve(values.data);
  if (command === 'mcp') return serveMcp(values.socket, values.endpoint, process.env.AGENT_TEAM_KEY, process.env.AGENT_TEAM_TURN);
  const socketPath = socketFor(directory);
  const groupArgs = () => ({
    name: values.name,
    workspace: values.workspace,
    lead: { name: '主 Agent', host: values.lead },
    members: parseMembers(values.members),
    modelMode: values['model-mode'],
    modelRules: values['model-rules'],
  });
  if (!['start', 'serve'].includes(command)) {
    let request;
    if (command === 'new' || command === 'prepare') {
      const p = await rpc(socketPath, { op: 'prepare', args: values.group ? { existingGroupId: values.group } : groupArgs() });
      const result = values.contract ? await rpc(socketPath, { op: 'propose', id: p.id, revision: p.revision, contract: JSON.parse(readFileSync(resolve(values.contract), 'utf8')) }) : p;
      console.log(JSON.stringify(result, null, 2)); return;
    }
    else if (command === 'preparation') request = { op: 'preparation', id: values.preparation };
    else if (command === 'preparation-chat') request = { op: 'preparation_chat', id: values.preparation, text: values.text };
    else if (command === 'propose') request = { op: 'propose', id: values.preparation, revision: Number(values.revision), contract: JSON.parse(readFileSync(resolve(values.contract), 'utf8')) };
    else if (command === 'approve') {
      const p = await rpc(socketPath, { op: 'preparation', id: values.preparation });
      if (p.revision !== Number(values.revision) || p.hash !== values.hash) throw new Error('确认版本或摘要不匹配，请重新查看草案');
      const reader = createInterface({ input: stdin, output: stdout });
      try { console.log(JSON.stringify(p, null, 2)); if (!/^y(es)?$/i.test((await reader.question('确认此契约并创建团队？[y/N] ')).trim())) return; }
      finally { reader.close(); }
      request = { op: 'approve_preparation', id: p.id, revision: p.revision, hash: p.hash };
    }
    else if (command === 'groups') request = { op: 'groups' };
    else if (command === 'models') request = { op: 'model_catalog', refresh: true };
    else if (command === 'chat' && values.text) request = { op: 'chat', group: values.group, text: values.text };
    else if (command === 'chat') return interactive(socketPath, values.group);
    else if (command === 'members') request = { op: 'members', group: values.group };
    else if (command === 'state' || command === 'requests') request = { op: 'collaboration', group: values.group };
    else if (command === 'direct') request = { op: 'directive', group: values.group, text: values.text };
    else if (command === 'decide') {
      const state = await rpc(socketPath, { op: 'collaboration', group: values.group });
      const r = state.requests.find(r => r.id === values.request && r.state === 'pending');
      if (!r || r.base_version !== Number(values.version)) throw new Error('待确认请求或版本不匹配');
      const reader = createInterface({ input: stdin, output: stdout }); let approved;
      try { console.log(JSON.stringify(r, null, 2)); approved = /^y(es)?$/i.test((await reader.question('批准此请求？[y/N，N将拒绝] ')).trim()); }
      finally { reader.close(); }
      request = { op: 'decide', group: values.group, id: r.id, version: r.base_version, approved };
    }
    else if (command === 'terminate' || command === 'reopen') request = { op: command, group: values.group, reason: values.reason };
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
  let confirming = false;
  const confirm = async text => {
    // An idle readline prompt already owns input. Background pairs must not steal it.
    if (!readline?.agentTeamBusy || confirming) return false;
    confirming = true;
    try { return /^y(es)?$/i.test((await readline.question(`${text} [y/N] `)).trim()); }
    finally { confirming = false; }
  };
  const panelAuth = process.env.AGENT_TEAM_DEV_NO_AUTH !== '1';
  const server = await startServer({ directory, port: Number(values.port), configFile: values.hosts, confirm, panelAuth });
  console.log(`Agent Team 0.1.0\n只读面板：${server.url}\n数据目录：${directory}${panelAuth ? '' : '\n开发模式：本机面板鉴权已关闭'}`);
  server.bus.on('notice', notice => stderr.write(`\n[系统通知] ${notice.text}\n`));
  let shuttingDown;
  const shutdown = () => shuttingDown ??= (async () => { readline?.close(); await server.close(); })();
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  if (command === 'serve') return;
  try {
    const group = values.group ? server.bus.store.group(values.group) : await prepareInteractive(socketPath, groupArgs(), readline);
    if (!group) return;
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
        if (line === '/help') { console.log('/state /requests /direct 文本 /decide 请求ID yes|no /terminate 原因 /reopen 原因 /resolve 运行ID 核实依据 /members /add 名称=宿主 /remove 名称 /stop 名称 /retry /groups /use 群编号 /delete /quit'); continue; }
        if (line.startsWith('/use ')) { group = line.slice(5).trim(); console.log(await rpc(socketPath, { op: 'members', group })); continue; }
        if (line === '/members') request = { op: 'members', group };
        else if (line === '/state' || line === '/requests') request = { op: 'collaboration', group };
        else if (line.startsWith('/direct ')) request = { op: 'directive', group, text: line.slice(8).trim() };
        else if (line.startsWith('/terminate ')) request = { op: 'terminate', group, reason: line.slice(11).trim() };
        else if (line.startsWith('/reopen ')) request = { op: 'reopen', group, reason: line.slice(8).trim() };
        else if (line.startsWith('/resolve ')) { const [turn, ...reason] = line.slice(9).trim().split(/\s+/); request = { op: 'resolve_runtime', group, turn, reason: reason.join(' ') }; }
        else if (line.startsWith('/decide ')) {
          const [id, answer] = line.slice(8).trim().split(/\s+/);
          if (!['yes', 'no'].includes(answer)) throw new Error('用法：/decide 请求ID yes|no');
          const state = await rpc(socketPath, { op: 'collaboration', group });
          const r = state.requests.find(r => r.id === id && r.state === 'pending');
          if (!r) throw new Error('待确认请求不存在');
          console.log(JSON.stringify(r, null, 2));
          if (answer === 'yes' && !/^y(es)?$/i.test((await readline.question('批准显示的请求？[y/N] ')).trim())) continue;
          request = { op: 'decide', group, id, version: r.base_version, approved: answer === 'yes' };
        }
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

async function prepareInteractive(socketPath, spec, readline) {
  let p = await rpc(socketPath, { op: 'prepare', args: spec });
  console.log('先在此对话中明确目标契约。输入任务意图；/contract查看草案，/approve确认建群，/quit退出。');
  while (!readline.closed) {
    let input; try { input = (await readline.question('\n你 > ')).trim(); } catch { return null; }
    if (!input) continue;
    if (input === '/quit') return null;
    if (input === '/contract' || input === '/approve') {
      p = await rpc(socketPath, { op: 'preparation', id: p.id });
      console.log(JSON.stringify(p, null, 2));
      if (input === '/approve' && p.contract && /^y(es)?$/i.test((await readline.question('确认当前契约及成员并创建团队？[y/N] ')).trim())) return rpc(socketPath, { op: 'approve_preparation', id: p.id, revision: p.revision, hash: p.hash });
      continue;
    }
    try { console.log(`\n主 Agent > ${await rpc(socketPath, { op: 'preparation_chat', id: p.id, text: input })}`); }
    catch (error) { stderr.write(`\n${error.message}\n`); }
  }
  return null;
}

main().catch(error => { stderr.write(`agent-team: ${error.message}\n`); process.exitCode = 1; });
