// 测试共用场景构造。
//
// 建群是直连语义:charter 只是注入每轮上下文的纯文本,不是授权闸门,也不需要确认流程。
// 这里保留薄封装,是为了把「测试建群」的默认参数集中在一处,不再复制到每个用例里。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bus } from '../../src/bus.mjs';
import { startServer } from '../../src/server.mjs';

export function createTestGroup(bus, args, charter = null) {
  return bus.createGroup({ ...args, ...(charter ? { charter } : {}) });
}

// Windows 上服务刚关闭时目录句柄可能还没释放,删除会 EPERM;统一带重试。
function cleanup(t, directory) {
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
}

/**
 * 直接落一条 Panel Agent 身份行。
 * 附件、遥测这类用例只需要"有一个私人会话主体",不走创建流程,
 * 免得为了建身份还要伪造宿主能力探测。表结构变化时只改这里。
 */
export function seedPanelAgent(bus, {
  id = randomUUID(),
  name = '测试助手',
  host = 'codex',
  provider = null,
  model = 'test-model',
  effort = null,
  workspace = null,
  access = 'read-only',
} = {}) {
  const now = new Date().toISOString();
  bus.store.run(
    `INSERT INTO panel_agents(id,singleton,name,host,model_provider,model,reasoning_effort,workspace,access,created,updated)
     VALUES(?,1,?,?,?,?,?,?,?,?,?)`,
    id, name, host, provider, model, effort, workspace, access, now, now,
  );
  return id;
}

/**
 * fake 宿主的统一语义:记录回合、上报会话、处理入群自述、接受输入后返回一段最终文本。
 * 各处原有差异都用显式选项表达,不靠"这个文件里恰好没调用"来区分。
 */
export function fakeHost({
  calls = [],
  run = null,
  profileText = 'I can help.',
  profileOutput = 'profile final',
  finalText = 'host final, not a group message',
  sessionOf = endpoint => `native-${endpoint.id}`,
  emitHostEvent = false,
} = {}) {
  return {
    calls,
    async run(context) {
      calls.push(context);
      context.onSession(context.endpoint.session ?? sessionOf(context.endpoint));
      if (emitHostEvent) context.onEvent({ type: 'host-event', prompt: context.prompt });
      if (context.endpoint.context === 'profile') {
        // profileText 为 null 表示用例不关心入群自述,不产生额外工具调用。
        if (profileText !== null) await context.onTool('profile_set', { text: profileText });
        context.onAccepted();
        return profileOutput;
      }
      if (run) return run(context);
      context.onAccepted();
      return finalText;
    },
  };
}

/**
 * 最常见的成员团队场景:临时数据目录 + 一个 fake 宿主 + 一位主 Agent 与若干成员。
 * 不在这里等空闲:需要"建群后先静下来"的调用方自己 await until(...),避免把等待语义藏进构造器。
 */
export function busScenario(t, {
  run = null,
  members = ['one', 'two'],
  name = 'group',
  charter = null,
  profileText = 'I can help.',
  finalText = 'host final, not a group message',
  sessionOf = endpoint => `native-${endpoint.id}`,
  emitHostEvent = true,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-test-'));
  const host = fakeHost({ run, profileText, finalText, sessionOf, emitHostEvent });
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  const spec = {
    name,
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: members.map(member => ({ name: member, host: 'fake' })),
  };
  const group = createTestGroup(bus, spec, charter);
  t.after(async () => {
    if (!bus.closing) await bus.close();
  });
  cleanup(t, directory);
  return { bus, group, members: bus.members(group.id), directory, spec, calls: host.calls, host };
}

/**
 * 起本地 HTTP 服务。传 members 时顺带建一个 fake 宿主团队;
 * 不传则只给空宿主表的服务器(设置类、附件类用例只需要 HTTP 表面)。
 */
export async function serverScenario(t, {
  hosts = new Map(),
  run = null,
  members = null,
  name = 'group',
  charter = null,
  directory = null,
  finalText = 'host final, not a group message',
} = {}) {
  const dataDirectory = directory ?? mkdtempSync(join(tmpdir(), 'agent-team-test-'));
  const needsHost = Boolean(run) || Boolean(members);
  const host = needsHost ? fakeHost({ run, finalText }) : null;
  const hostMap = new Map(hosts);
  if (host) hostMap.set('fake', host);
  const server = await startServer({ directory: dataDirectory, hosts: hostMap });
  t.after(async () => {
    await server.close();
  });
  cleanup(t, dataDirectory);
  const base = { server, url: server.url, bus: server.bus, directory: dataDirectory, calls: host?.calls ?? [] };
  if (!members) return base;
  const group = createTestGroup(server.bus, {
    name,
    workspace: dataDirectory,
    lead: { name: 'lead', host: 'fake' },
    members: members.map(member => ({ name: member, host: 'fake' })),
  }, charter);
  return { ...base, group, members: server.bus.members(group.id) };
}
