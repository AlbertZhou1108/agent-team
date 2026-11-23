// 桌面应用定义表:一个受支持的桌面应用要接入框架的全部检测事实都在这里声明。
// 与 hosts/definitions.mjs 同构——检测/验证的消费点都从本表派生;验证策略
// (verify)由各宿主桌面切片填充,框架只负责编排、额度确认门、超时与清理。
//
// 探测路径来自 macOS 与 Windows 实机核对:
// - Codex Desktop:
//   - macOS: /Applications/ChatGPT.app,内嵌引擎在 Contents/Resources/codex-cli/.../codex;
//   - Windows: MSIX 包 OpenAI.Codex_* (WindowsApps),内嵌引擎在 app/resources/codex.exe;
// - DSH Desktop:
//   - macOS: /Applications/DeepSeek Harness.app,内嵌引擎 Contents/Resources/runtime/cli/bin/dsh;
//   - Windows: %LOCALAPPDATA%\Programs\DeepSeek Harness,内嵌引擎 resources/runtime/cli/bin/dsh.cmd;
// - Claude Desktop:
//   - macOS: /Applications/Claude.app,引擎下载到 ~/Library/Application Support/Claude-3p/claude-code/<版本>/<hash>/claude.app/Contents/MacOS/claude;
//   - Windows: MSIX 包 Claude_* (WindowsApps),引擎下载到 %LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<hash>\claude.exe;
// - ZCode Desktop:
//   - macOS: /Applications/ZCode.app,内嵌引擎 Contents/Resources/glm/zcode.cjs;
//   - Windows: %ProgramFiles%\ZCode 或 %LOCALAPPDATA%\Programs\ZCode,内嵌引擎 resources/glm/zcode.cjs。
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function defaultClaudeEngineRoots(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', 'Claude-3p', 'claude-code')];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
    return [
      join(local, 'Claude-3p', 'claude-code'),
      join(roaming, 'Claude', 'claude-code'),
      join(local, 'Claude', 'claude-code'),
    ];
  }
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return [
    join(data, 'Claude-3p', 'claude-code'),
    join(config, 'Claude', 'claude-code'),
  ];
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))];
}

function rootsOf(context) {
  if (Array.isArray(context.applicationsRoots)) return uniqueStrings(context.applicationsRoots);
  if (typeof context.applicationsRoot === 'string' && context.applicationsRoot) return [context.applicationsRoot];
  return [];
}

function supportRootsOf(context) {
  if (Array.isArray(context.supportRoots)) return uniqueStrings(context.supportRoots);
  if (typeof context.supportRoot === 'string' && context.supportRoot) return [context.supportRoot];
  return [];
}

function msixMatches(context, prefix) {
  const packages = Array.isArray(context.msixPackages) ? context.msixPackages : [];
  return packages
    .filter(item => typeof item?.name === 'string' && item.name.startsWith(prefix) && typeof item.root === 'string')
    .map(item => item.root);
}

function hasAny(basePath, relativePaths) {
  return relativePaths.some(relativePath => existsSync(join(basePath, relativePath)));
}

/**
 * Claude 内嵌引擎按下载目录枚举:<版本>/<hash>/{claude.app/Contents/MacOS/claude | claude.exe | claude}。
 * 支持传入单个目录字符串或目录数组,按版本号降序返回。
 */
export function claudeEngineCandidates(supportRoots = defaultClaudeEngineRoots()) {
  const raw = typeof supportRoots === 'function' ? supportRoots() : supportRoots;
  const roots = Array.isArray(raw) ? uniqueStrings(raw) : (typeof raw === 'string' && raw ? [raw] : []);
  const seen = new Set();
  const found = [];
  for (const root of roots) {
    let versions;
    try { versions = readdirSync(root); } catch { continue; }
    for (const version of versions) {
      let hashes;
      try { hashes = readdirSync(join(root, version)); } catch { continue; }
      for (const hash of hashes) {
        const candidates = [
          join(root, version, hash, 'claude.app', 'Contents', 'MacOS', 'claude'),
          join(root, version, hash, 'claude.exe'),
          join(root, version, hash, 'claude'),
        ];
        const matched = candidates.find(candidate => existsSync(candidate));
        if (matched && !seen.has(matched)) {
          seen.add(matched);
          found.push({ path: matched, version });
        }
      }
    }
  }
  return found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

export const DESKTOP_DEFINITIONS = new Map([
  ['codex', {
    label: 'Codex',
    bundleCandidates: context => {
      const roots = rootsOf(context);
      if (context.platform === 'darwin') {
        return uniqueStrings(roots.flatMap(root => [join(root, 'ChatGPT.app'), join(root, 'Codex.app')]));
      }
      if (context.platform === 'win32') {
        return uniqueStrings([
          ...msixMatches(context, 'OpenAI.Codex_'),
          ...roots.flatMap(root => [join(root, 'Codex'), join(root, 'ChatGPT')]),
        ]);
      }
      return uniqueStrings(roots.flatMap(root => [join(root, 'Codex'), join(root, 'codex'), join(root, 'chatgpt')]));
    },
    isValidBundle: bundlePath => hasAny(bundlePath, [
      'Contents/Info.plist',
      'AppxManifest.xml',
      'app/Codex.exe',
      'app/resources/codex.exe',
      'Codex.exe',
      'resources/app.asar',
      'app/resources/app.asar',
    ]),
    engineCandidates: ({ bundlePath }) => [
      { path: join(bundlePath, 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex') },
      { path: join(bundlePath, 'app', 'resources', 'codex.exe') },
      { path: join(bundlePath, 'resources', 'codex.exe') },
      { path: join(bundlePath, 'resources', 'codex') },
    ],
    engineVersionArgs: ['--version'],
  }],
  ['dsh', {
    label: 'DeepSeek Harness',
    bundleCandidates: context => {
      const roots = rootsOf(context);
      if (context.platform === 'darwin') {
        return uniqueStrings(roots.map(root => join(root, 'DeepSeek Harness.app')));
      }
      if (context.platform === 'win32') {
        return uniqueStrings(roots.flatMap(root => [join(root, 'DeepSeek Harness'), join(root, 'DSH')]));
      }
      return uniqueStrings(roots.flatMap(root => [join(root, 'DeepSeek Harness'), join(root, 'deepseek-harness')]));
    },
    isValidBundle: bundlePath => hasAny(bundlePath, [
      'Contents/Info.plist',
      'DeepSeek Harness.exe',
      'resources/app.asar',
      'resources/runtime/cli/bin/dsh.cmd',
      'resources/runtime/cli/bin/dsh.exe',
      'resources/runtime/cli/bin/dsh',
    ]),
    engineCandidates: ({ bundlePath }) => [
      { path: join(bundlePath, 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh') },
      { path: join(bundlePath, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd') },
      { path: join(bundlePath, 'resources', 'runtime', 'cli', 'bin', 'dsh.exe') },
      { path: join(bundlePath, 'resources', 'runtime', 'cli', 'bin', 'dsh') },
    ],
    engineVersionArgs: ['--version'],
  }],
  ['claude', {
    label: 'Claude',
    bundleCandidates: context => {
      const roots = rootsOf(context);
      if (context.platform === 'darwin') {
        return uniqueStrings(roots.map(root => join(root, 'Claude.app')));
      }
      if (context.platform === 'win32') {
        return uniqueStrings([
          ...msixMatches(context, 'Claude_'),
          ...roots.flatMap(root => [join(root, 'Claude'), join(root, 'AnthropicClaude')]),
        ]);
      }
      return uniqueStrings(roots.flatMap(root => [join(root, 'Claude'), join(root, 'claude')]));
    },
    isValidBundle: bundlePath => hasAny(bundlePath, [
      'Contents/Info.plist',
      'AppxManifest.xml',
      'app/claude.exe',
      'claude.exe',
      'Claude.exe',
      'resources/app.asar',
      'app/resources/app.asar',
    ]),
    // 注意:claudeEngineCandidates 期望的是 Claude-3p/claude-code 或 Claude/claude-code 目录,
    // 不是支持目录本身——传错根会静默扫不到引擎。
    engineCandidates: context => claudeEngineCandidates(
      supportRootsOf(context).flatMap(root => [
        join(root, 'Claude-3p', 'claude-code'),
        join(root, 'Claude', 'claude-code'),
      ]),
    ),
    engineVersionArgs: ['--version'],
    lifecycleNote: '内嵌引擎由桌面应用下载到本地数据目录；未运行过应用时引擎不存在',
  }],
  ['zcode', {
    label: 'ZCode',
    bundleCandidates: context => {
      const roots = rootsOf(context);
      if (context.platform === 'darwin') {
        return uniqueStrings(roots.map(root => join(root, 'ZCode.app')));
      }
      if (context.platform === 'win32') {
        return uniqueStrings(roots.map(root => join(root, 'ZCode')));
      }
      return uniqueStrings(roots.flatMap(root => [join(root, 'ZCode'), join(root, 'zcode')]));
    },
    isValidBundle: bundlePath => hasAny(bundlePath, [
      'Contents/Info.plist',
      'ZCode.exe',
      'zcode',
      'resources/glm/zcode.cjs',
      'Contents/Resources/glm/zcode.cjs',
    ]),
    engineCandidates: ({ bundlePath }) => [
      { path: join(bundlePath, 'Contents', 'Resources', 'glm', 'zcode.cjs') },
      { path: join(bundlePath, 'resources', 'glm', 'zcode.cjs') },
    ],
    // zcode.cjs 是经 Node/Electron 驱动的 CommonJS 入口模块,不是独立 --version CLI。
    engineVersionArgs: null,
  }],
]);

export function desktopDefinition(kind, { definitions = DESKTOP_DEFINITIONS } = {}) {
  return definitions.get(kind) ?? null;
}
