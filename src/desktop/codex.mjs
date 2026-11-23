// Codex Desktop 垂直切片:接入安装(激活连接 + ~/.codex/config.toml 受管条目)与
// 验证策略(主控检查/引擎检查)。
//
// 会话身份模型:桌面配置里只能放一条全局 MCP 条目,所以安装写入的是「激活连接」
// 凭据;MCP 子进程带 CODEX_THREAD_ID,控制面据此解析出每会话独立的会话连接
// (见 control-plane.resolveActivationBinding)。主动唤醒走已验证的 app-server resume。
//
// 验证策略的真实运行会消耗模型额度(由验证执行器的额度确认门保护),且隔离
// CODEX_HOME 是否被桌面内嵌引擎尊重、auth 链接是否够用,都要真宿主验收确认。
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExternalIdentity } from '../control-plane.mjs';
import { nodeRunner } from '../runtime.mjs';
import { disableBinding } from '../aggregates/external-control.mjs';
import { restrictPrivateFile } from '../private-permissions.mjs';
import { writeDesktopHostSpec } from './member-hosts.mjs';
import { CONTROL_MCP_NAME, desktopControlMcpSpec } from './mcp-spec.mjs';
export const BLOCK_BEGIN = '# ---- agent-team managed block:begin (由 Agent Team 维护,重装即更新) ----';
export const BLOCK_END = '# ---- agent-team managed block:end ----';

export function codexDesktopCliPath(cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url))) {
  return cliPath;
}

function tomlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const PROVIDER_TOP_LEVEL_KEYS = new Set([
  'model_provider',
  'model',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'model_catalog_json',
  'chatgpt_base_url',
  'preferred_auth_method',
  'oss_provider',
  'profile',
]);

const PROVIDER_TABLE_HEADER = /^\[(?:model_providers|profiles)(?:\.|\])/;

/**
 * 从用户 ~/.codex/config.toml 中提取模型与 provider 路由配置(不含 mcp_servers / plugins / projects),
 * 供隔离 CODEX_HOME(验证会话与桌面成员宿主)继承。相对路径的 model_catalog_json 解析为源目录下的绝对路径。
 */
export function extractCodexProviderConfig(configText, sourceCodexHome = join(homedir(), '.codex')) {
  if (typeof configText !== 'string' || !configText.trim()) return '';
  const topLines = [];
  const tableBlocks = [];
  let inTable = false;
  let keepTable = false;
  let currentBlock = [];
  const flushTable = () => {
    if (keepTable && currentBlock.length) tableBlocks.push(currentBlock.join('\n').trimEnd());
    currentBlock = [];
  };
  for (const rawLine of configText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('[')) {
      flushTable();
      inTable = true;
      keepTable = PROVIDER_TABLE_HEADER.test(trimmed);
      if (keepTable) currentBlock.push(rawLine);
      continue;
    }
    if (!inTable) {
      const keyMatch = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed);
      if (!keyMatch || !PROVIDER_TOP_LEVEL_KEYS.has(keyMatch[1])) continue;
      if (keyMatch[1] === 'model_catalog_json') {
        const pathMatch = /^(\s*model_catalog_json\s*=\s*)(['"])([^'"]+)\2(.*)$/.exec(rawLine);
        if (pathMatch && !isAbsolute(pathMatch[3])) {
          topLines.push(`${pathMatch[1]}${tomlLiteral(join(sourceCodexHome, pathMatch[3]))}${pathMatch[4]}`);
          continue;
        }
      }
      topLines.push(rawLine);
    } else if (keepTable) {
      currentBlock.push(rawLine);
    }
  }
  flushTable();
  const sections = [];
  if (topLines.length) sections.push(topLines.join('\n'));
  if (tableBlocks.length) sections.push(tableBlocks.join('\n\n'));
  return sections.length ? `${sections.join('\n\n')}\n` : '';
}

function readUserCodexProviderConfig(sourceCodexHome = join(homedir(), '.codex')) {
  const sourcePath = join(sourceCodexHome, 'config.toml');
  if (!existsSync(sourcePath)) return '';
  try {
    return extractCodexProviderConfig(readFileSync(sourcePath, 'utf8'), sourceCodexHome);
  } catch {
    return '';
  }
}

function combineCodexConfig(providerConfig, extraConfig) {
  const parts = [providerConfig?.trim(), extraConfig?.trim()].filter(Boolean);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

function summarizeExecStderr(stderr, stdout) {
  const source = (stderr || stdout || '').trim();
  if (!source) return '';
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find(line => /(?:error|failed|timeout|unauthorized|forbidden|refused|missing|invalid|not found)/i.test(line));
  return (errorLine ?? lines.at(-1) ?? '').slice(0, 400);
}

/** 受管 TOML 条目:单引号字面量字符串,Windows 反斜杠路径无需转义。 */
export function codexDesktopMcpBlock({ socketPath, bindingId, clientKey, runner = nodeRunner(), cliPath = codexDesktopCliPath() }) {
  const spec = desktopControlMcpSpec({ socketPath, bindingId, clientKey, runner, cliPath });
  return [
    BLOCK_BEGIN,
    `[mcp_servers.${CONTROL_MCP_NAME}]`,
    `command = ${tomlLiteral(spec.command)}`,
    `args = [${spec.args.map(tomlLiteral).join(', ')}]`,
    `env = { ${Object.entries(spec.env).map(([name, value]) => `${tomlLiteral(name)} = ${tomlLiteral(value)}`).join(', ')} }`,
    BLOCK_END,
  ].join('\n');
}

export const PLUGIN_NAME = 'agent-team@agent-team';
const PLUGIN_MARKETPLACE = 'agent-team';

/** cliPath 指向 <root>/src/cli.mjs;仓库根即其两级父目录。 */
function repositoryRoot(cliPath) {
  return dirname(dirname(cliPath));
}

function pluginVersionFor(cliPath) {
  try {
    const version = JSON.parse(readFileSync(join(repositoryRoot(cliPath), 'package.json'), 'utf8')).version;
    return typeof version === 'string' && version ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Codex Desktop 聊天宿主(code mode)读的是插件机制,不是 config.toml 的
 * [mcp_servers.*]。插件目录里的 .mcp.json 与受管块同源,额外带 enabled 与
 * 工具审批策略——缺了它,桌面聊天里的模型看不到 Agent Team 工具。
 */
export function codexDesktopPluginMcp({ socketPath, bindingId, clientKey, runner = nodeRunner(), cliPath = codexDesktopCliPath() }) {
  return {
    mcpServers: {
      [CONTROL_MCP_NAME]: {
        ...desktopControlMcpSpec({ socketPath, bindingId, clientKey, runner, cliPath }),
        enabled: true,
        default_tools_approval_mode: 'never',
      },
    },
  };
}

/**
 * 幂等开启 [plugins."<pluginName>"]:表存在则确保 enabled=true(含从 false 翻转),
 * 不存在则追加。只动这一个键,保留 Codex 重排后的其余内容。
 */
export function applyPluginEnabled(configText, pluginName = PLUGIN_NAME) {
  const header = `[plugins."${pluginName}"]`;
  const index = configText.indexOf(header);
  if (index < 0) {
    const separator = configText.trim().length ? '\n\n' : '';
    return `${configText.replace(/\s*$/, '')}${separator}${header}\nenabled = true\n`;
  }
  const bodyStart = index + header.length;
  const rest = configText.slice(bodyStart);
  const nextTable = rest.search(/\n\[/);
  const bodyEnd = nextTable < 0 ? configText.length : bodyStart + nextTable;
  const body = configText.slice(bodyStart, bodyEnd);
  // 行内空白用 [ \t],不能用 \s:后者含换行,替换时会吞掉行尾换行、把后续内容整体上移。
  const enabledLine = /^([ \t]*)enabled[ \t]*=[ \t]*(?:true|false)[ \t]*$/m;
  const replaced = enabledLine.test(body)
    ? body.replace(enabledLine, '$1enabled = true')
    : `\nenabled = true${body}`;
  return configText.slice(0, bodyStart) + replaced + configText.slice(bodyEnd);
}

/** 替换既有的受管块;没有则追加到文件尾(追加表在 TOML 中合法)。 */export function applyManagedBlock(configText, block) {
  const body = block.replace(/\s*$/, '');
  const begin = configText.indexOf(BLOCK_BEGIN);
  const end = configText.indexOf(BLOCK_END);
  if (begin >= 0 && end >= 0 && end > begin) {
    return `${configText.slice(0, begin)}${body}\n${configText.slice(end + BLOCK_END.length)}`.replace(/\n{3,}/g, '\n\n');
  }
  if (begin >= 0 || end >= 0) throw new Error('config.toml 存在不完整的 agent-team 受管块,请手动修复后重试');
  const separator = configText.trim().length ? '\n\n' : '';
  return `${configText.replace(/\s*$/, '')}${separator}${body}\n`;
}

function assertNoUnmanagedEntry(configText) {
  // 剥掉完整受管块后再查重:受管块内的条目是自己写的,不算冲突。
  const begin = configText.indexOf(BLOCK_BEGIN);
  const end = configText.indexOf(BLOCK_END);
  const withoutBlock = begin >= 0 && end >= 0 && end > begin
    ? configText.slice(0, begin) + configText.slice(end + BLOCK_END.length)
    : configText;
  if (new RegExp(`\\[mcp_servers\\.${CONTROL_MCP_NAME}\\]`).test(withoutBlock)) {
    throw new Error(`config.toml 已有非受管的 [mcp_servers.${CONTROL_MCP_NAME}] 条目;请手动迁移到 agent-team 受管块后重试`);
  }
}

/**
 * 安装 Codex Desktop 集成:检测应用 → 建激活连接 → 备份并写入 config.toml 受管条目。
 * key 只写入宿主配置(0600),不出现在返回值里。
 */
export async function installCodexDesktopIntegration(store, {
  principalName = '本机用户',
  detections,
  codexHome = join(homedir(), '.codex'),
  socketPath,
  runner = nodeRunner(),
  cliPath = codexDesktopCliPath(),
  pluginVersion = null,
  now = new Date().toISOString(),
} = {}) {
  if (!socketPath) throw new Error('桌面接入安装需要总线 socket 路径');
  const detected = detections?.find?.(item => item.kind === 'codex' && item.found);
  if (!detected) throw new Error('未检测到 Codex Desktop 安装;请先安装桌面应用再接入');
  if (!detected.enginePath) throw new Error('Codex Desktop 未提供内嵌执行引擎;无法完成桌面接入');

  // 激活连接的声明能力:桌面会话可收发、可观察、可唤醒、可询问用户。
  // workspaceRoots 以用户主目录为上界;真实工作目录由会话 cwd 跟随(ADR 0012)。
  const identity = createExternalIdentity(store, {
    principalName,
    bindingName: 'Codex Desktop 接入',
    host: 'codex',
    session: null,
    declared: {
      capabilities: ['session.deliver', 'turn.observe', 'session.wake', 'user.elicit', 'user.notify'],
      workspaceRoots: [homedir()],
      policies: ['communication', 'read-only', 'workspace-write'],
    },
    surface: 'desktop',
    appId: detected.applicationId,
    bindingKind: 'activation',
  });

  const configPath = join(codexHome, 'config.toml');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  assertNoUnmanagedEntry(configText);
  const block = codexDesktopMcpBlock({ socketPath, bindingId: identity.binding.id, clientKey: identity.key, runner, cliPath });
  let backupPath = null;
  let backupHash = null;
  if (configText) {
    backupPath = `${configPath}.agent-team-backup-${now.replace(/[:.]/g, '-')}`;
    copyFileSync(configPath, backupPath);
    restrictPrivateFile(backupPath);
    backupHash = createHash('sha256').update(configText).digest('hex');
  }
  const nextConfig = applyPluginEnabled(applyManagedBlock(configText, block));
  writeFileSync(configPath, nextConfig, { mode: 0o600 });

  // 桌面聊天宿主只认插件机制:写插件目录 + .mcp.json + marketplace 元数据。
  // config.toml 受管块保留给 CLI 侧(codex exec 读 [mcp_servers.*])。
  const version = pluginVersion ?? pluginVersionFor(cliPath);
  const pluginRoot = join(codexHome, 'plugins', 'cache', PLUGIN_MARKETPLACE, PLUGIN_MARKETPLACE, version);
  mkdirSync(pluginRoot, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(pluginRoot, '.mcp.json'),
    `${JSON.stringify(codexDesktopPluginMcp({ socketPath, bindingId: identity.binding.id, clientKey: identity.key, runner, cliPath }), null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(pluginRoot, '.codex-marketplace-install.json'),
    `${JSON.stringify({ source_type: 'local', source: repositoryRoot(cliPath), ref_name: 'main', sparse_paths: [], revision: 'local' }, null, 2)}\n`,
    { mode: 0o600 },
  );

  // 成员宿主:内嵌引擎在框架私有 CODEX_HOME 里跑成员回合,不写用户可见聊天历史。
  // 目录必须真实存在(引擎会在 CODEX_HOME 不存在时直接退出),并复用桌面登录态与自定义 provider 路由。
  const member = codexDesktopMemberHostSpec({ enginePath: detected.enginePath, dataDirectory: store.directory });
  const memberHome = member.spec.env.CODEX_HOME;
  mkdirSync(memberHome, { recursive: true, mode: 0o700 });
  const memberProviderConfig = extractCodexProviderConfig(configText, codexHome);
  if (memberProviderConfig) {
    writeFileSync(join(memberHome, 'config.toml'), memberProviderConfig, { mode: 0o600 });
  }
  try {
    linkAuth(join(codexHome, 'auth.json'), join(memberHome, 'auth.json'));
  } catch {
    // 未登录、平台不支持或链接已存在:交给引擎自身报告失败原因。
  }
  writeDesktopHostSpec(store.directory, member.hostName, member.spec);

  return {
    applicationId: detected.applicationId,
    binding: {
      id: identity.binding.id,
      name: identity.binding.name,
      bindingKind: 'activation',
      surface: 'desktop',
      host: identity.binding.host,
    },
    configPath,
    pluginPath: pluginRoot,
    pluginVersion: version,
    memberHost: member.hostName,
    socketPath,
    backupPath,
    backupHash,
    enginePath: detected.enginePath,
    engineVersion: detected.engineVersion,
    nextStep: '重启 Codex Desktop 使插件与 MCP 配置生效;在桌面会话内调用 Agent Team Skill 即把该会话激活为桌面主控。',
  };
}

// --- 验证策略(计划 §3.2;真实运行消耗模型额度) ------------------------------

const CONTROLLER_CHECK_PROMPT = '你是 Agent Team 桌面接入验证会话。调用一次 control_protocol 工具,把返回 JSON 里的 version 数字原样写在最终回复里,不要做其他事情。';
const ENGINE_CHECK_PROMPT = '只回复两个字符:OK';

/**
 * 复用桌面登录态:POSIX 用符号链接,Windows 用复制——symlink 需要开发者模式,
 * 且悬空链接会让临时目录删除永久 EPERM。源不存在时抛错,由调用方决定降级。
 */
function linkAuth(source, target) {
  if (process.platform === 'win32') copyFileSync(source, target);
  else symlinkSync(source, target);
}

function isolatedCodexHome(configText, {
  sourceCodexHome = join(homedir(), '.codex'),
  home = join(homedir(), '.agent-team', 'desktop-verify', randomUUID()),
} = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // 继承用户 ~/.codex/config.toml 中的模型与自定义 provider 路由(不含用户 MCP/插件),
  // 避免自定义 provider(如本地代理/中转)在隔离目录中丢失配置并回落到默认端点超时。
  const providerConfig = readUserCodexProviderConfig(sourceCodexHome);
  writeFileSync(join(home, 'config.toml'), combineCodexConfig(providerConfig, configText), { mode: 0o600 });
  // 复用桌面应用的登录态而不复制凭据文件:POSIX 用符号链接,Windows 用复制。
  let authLinked = false;
  try {
    linkAuth(join(sourceCodexHome, 'auth.json'), join(home, 'auth.json'));
    authLinked = true;
  } catch {
    // 无登录态或平台不支持:交给引擎自身报告失败原因。
  }
  return { home, authLinked };
}

async function runCodexExec({ enginePath, workspace, spawnTracked, timeoutMs, codexHome, prompt }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exitDrainTimer = null;
    let timer = null;
    const child = spawnTracked(enginePath, ['exec', '--skip-git-repo-check', '--ephemeral', '-C', workspace, prompt], {
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (ok) resolve(value);
      else reject(value);
    };
    timer = setTimeout(() => finish(false, new Error('验证回合超时')), timeoutMs);
    let output = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const completeWithCode = code => {
      if (code === 0) finish(true, output);
      else {
        const detail = summarizeExecStderr(stderr, output);
        finish(false, new Error(detail ? `内嵌引擎退出 (${code})：${detail}` : `内嵌引擎退出 (${code})`));
      }
    };
    // Windows 上 Codex 0.171+ 派生的后台守护子进程可能继承 stdout/stderr 管道句柄,
    // 导致主进程 exit(0) 后 close 延迟 90 秒以上才触发;exit 后给 200ms 排空缓冲即结算。
    child.on('exit', code => {
      if (settled || exitDrainTimer) return;
      exitDrainTimer = setTimeout(() => completeWithCode(code), 200);
      exitDrainTimer.unref?.();
    });
    child.on('close', code => completeWithCode(code));
    child.on('error', error => finish(false, new Error(`无法启动内嵌引擎: ${error.message}`)));
  });
}

/**
 * Codex Desktop 验证策略。
 * 主控检查:隔离 CODEX_HOME + 一次性验证连接,让内嵌引擎的模型看见并调用
 * control_protocol;引擎检查:内嵌引擎在临时工作区完成一个短任务。
 * 两项检查的临时目录与临时连接都在结束路径清理;真实额度消耗由额度确认门保护。
 */
export function codexDesktopVerification() {
  return {
    async verifyController({ store, workspace, detection, spawnTracked, socketPath, timeoutMs }) {
      if (!socketPath) return { ok: false, reason: '总线 socket 不可用,无法配置验证 MCP' };
      const temp = createExternalIdentity(store, {
        principalName: 'Agent Team 验证',
        bindingName: `codex-desktop-verify-${randomUUID().slice(0, 8)}`,
        host: 'codex',
        declared: {
          capabilities: ['session.deliver', 'turn.observe'],
          workspaceRoots: [homedir()],
          policies: ['read-only'],
        },
        surface: 'desktop',
      });
      try {
        const { home, authLinked } = isolatedCodexHome(
          codexDesktopMcpBlock({ socketPath, bindingId: temp.binding.id, clientKey: temp.key }),
          { home: join(workspace, 'codex-verify-controller-home') },
        );
        try {
          const output = await runCodexExec({
            enginePath: detection.enginePath,
            workspace,
            spawnTracked,
            timeoutMs,
            codexHome: home,
            prompt: CONTROLLER_CHECK_PROMPT,
          });
          const ok = /version|1/.test(output);
          return {
            ok,
            // 失败时必须如实说「没确认到版本」,不能固定写「可调用」——否则诊断会掩盖真实原因。
            detail: ok
              ? `主控工具可调用${authLinked ? '' : '(未链接宿主登录态)'}`
              : '回合未返回可确认的 control_protocol 版本',
          };
        } finally {
          try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* 清理失败不覆盖验证结论 */ }
        }
      } finally {
        disableBinding(store, temp.binding.id);
      }
    },
    async verifyEngine({ workspace, detection, spawnTracked, timeoutMs }) {
      const { home } = isolatedCodexHome('', { home: join(workspace, 'codex-verify-engine-home') });
      try {
        const output = await runCodexExec({
          enginePath: detection.enginePath,
          workspace,
          spawnTracked,
          timeoutMs,
          codexHome: home,
          prompt: ENGINE_CHECK_PROMPT,
        });
        return { ok: /ok/i.test(output), detail: '内嵌引擎完成短任务' };
      } finally {
        try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* 清理失败不覆盖验证结论 */ }
      }
    },
  };
}

// --- 桌面引擎成员的宿主规格 --------------------------------------------------

/**
 * 桌面内嵌引擎作为成员执行器的宿主规格:引擎路径指向桌面 bundle,
 * CODEX_HOME 指向框架私有目录——成员会话与用户可见的桌面聊天历史隔离。
 * 由接入安装或面板把它合并进服务宿主配置(hosts.json)。
 */
export function codexDesktopMemberHostSpec({ enginePath, dataDirectory, hostName = 'codex-desktop' } = {}) {
  if (!enginePath) throw new Error('桌面引擎成员需要内嵌引擎路径');
  if (!dataDirectory) throw new Error('桌面引擎成员需要框架数据目录');
  return {
    hostName,
    spec: {
      adapter: 'codex',
      command: enginePath,
      env: { CODEX_HOME: join(dataDirectory, 'desktop-engines', 'codex') },
    },
  };
}
