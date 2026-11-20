// 桌面应用定义表:一个受支持的桌面应用要接入框架的全部检测事实都在这里声明。
// 与 hosts/definitions.mjs 同构——检测/验证的消费点都从本表派生;验证策略
// (verify)由各宿主桌面切片填充,框架只负责编排、额度确认门、超时与清理。
//
// 探测路径来自 2026-11 的实机核对(见 docs/handover-2026-11-19-desktop-integration.md):
// - Codex Desktop /Applications/ChatGPT.app,内嵌引擎在 bundle 资源内;
// - DSH Desktop /Applications/DeepSeek Harness.app,内嵌 dsh 在 bundle 资源内;
// - Claude Desktop /Applications/Claude.app 的引擎不在 bundle 内,而是应用
//   运行后下载到 ~/Library/Application Support/Claude-3p/claude-code/<版本>/<hash>/;
// - ZCode Desktop /Applications/ZCode.app,内嵌引擎是 bundle 资源内的 glm/zcode.cjs
//   (node 脚本,启动与 provider 配置布局由 member/zcode/wake.mjs 的 launch 解析兼容)。
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_ENGINE_ROOT = () => join(homedir(), 'Library', 'Application Support', 'Claude-3p', 'claude-code');

/** Claude 内嵌引擎按 下载目录枚举:<版本>/<hash>/claude.app/Contents/MacOS/claude。 */
export function claudeEngineCandidates(supportRoot = CLAUDE_ENGINE_ROOT()) {
  const root = typeof supportRoot === 'string' ? supportRoot : supportRoot();
  const found = [];
  let versions;
  try { versions = readdirSync(root); } catch { return found; }
  for (const version of versions) {
    let hashes;
    try { hashes = readdirSync(join(root, version)); } catch { continue; }
    for (const hash of hashes) {
      const path = join(root, version, hash, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (existsSync(path)) found.push({ path, version });
    }
  }
  return found.sort((a, b) => b.version.localeCompare(a.version));
}

export const DESKTOP_DEFINITIONS = new Map([
  ['codex', {
    label: 'Codex',
    bundleCandidates: ({ applicationsRoot }) => [join(applicationsRoot, 'ChatGPT.app')],
    engineCandidates: ({ bundlePath }) => [
      { path: join(bundlePath, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex') },
    ],
    engineVersionArgs: ['--version'],
  }],
  ['dsh', {
    label: 'DSH',
    bundleCandidates: ({ applicationsRoot }) => [join(applicationsRoot, 'DeepSeek Harness.app')],
    engineCandidates: ({ bundlePath }) => [
      { path: join(bundlePath, 'Contents/Resources/runtime/cli/bin/dsh') },
    ],
    engineVersionArgs: ['--version'],
  }],
  ['claude', {
    label: 'Claude',
    bundleCandidates: ({ applicationsRoot }) => [join(applicationsRoot, 'Claude.app')],
    // 注意:claudeEngineCandidates 期望的是 Claude-3p/claude-code 根目录,
    // 不是 Application Support 本身——传错根会静默扫不到引擎。
    engineCandidates: ({ supportRoot }) => claudeEngineCandidates(join(supportRoot, 'Claude-3p', 'claude-code')),
    engineVersionArgs: ['--version'],
    lifecycleNote: '内嵌引擎由桌面应用下载到本地数据目录；未运行过应用时引擎不存在',
  }],
  ['zcode', {
    label: 'ZCode',
    bundleCandidates: ({ applicationsRoot }) => [join(applicationsRoot, 'ZCode.app')],
    engineCandidates: ({ bundlePath }) => [
      { path: join(bundlePath, 'Contents/Resources/glm/zcode.cjs') },
    ],
  }],
]);

export function desktopDefinition(kind, { definitions = DESKTOP_DEFINITIONS } = {}) {
  return definitions.get(kind) ?? null;
}
