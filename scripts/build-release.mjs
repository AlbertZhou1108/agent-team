import { cpSync, mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const repo = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(repo, 'package.json'))).version;
const output = resolve(process.argv[2] ?? join(repo, 'dist', `agent-team-${process.platform}-${process.arch}`));
const insideSource = relative(repo, output);
if (!insideSource.startsWith('..') && !insideSource.startsWith(`dist${sep}`)) throw new Error('仓库内的发行产物只能放在 dist 子目录，避免递归打包源码');
if (existsSync(output)) throw new Error('输出目录已存在，请选择新目录；不会覆盖正在使用的发行文件');
if (!existsSync(join(repo, 'web/dist/index.html'))) throw new Error('请先执行 npm run build');
const application = process.platform === 'darwin' ? join(output, 'Agent Team.app', 'Contents', 'Resources', 'application') : output;
mkdirSync(join(application, 'runtime'), { recursive: true });
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
cpSync(process.execPath, join(application, 'runtime', nodeName));
chmodSync(join(application, 'runtime', nodeName), 0o755);
const nodeLicense = [resolve(dirname(process.execPath), '../LICENSE'), join(dirname(process.execPath), 'LICENSE')].find(path => existsSync(path));
if (!nodeLicense) throw new Error('未找到当前 Node 的 LICENSE，请使用包含许可证的完整 Node 发行环境构建');
cpSync(nodeLicense, join(application, 'runtime', 'LICENSE'));
cpSync(join(repo, 'src'), join(application, 'src'), { recursive: true });
cpSync(join(repo, 'web/dist'), join(application, 'web/dist'), { recursive: true });
writeFileSync(join(application, 'package.json'), JSON.stringify({ name: 'agent-team-local', private: true, type: 'module', version }, null, 2));
const dependencies = {};
function copyDependency(name, from, modules = join(application, 'node_modules'), ancestors = new Set()) {
  const require = createRequire(join(from, 'package.json'));
  let root = dirname(realpathSync(require.resolve(name)));
  while (!existsSync(join(root, 'package.json')) || JSON.parse(readFileSync(join(root, 'package.json'))).name !== name) {
    const parent = dirname(root);
    if (parent === root) throw new Error(`无法定位依赖：${name}`);
    root = parent;
  }
  if (ancestors.has(root)) throw new Error(`依赖循环需要单独处理：${name}`);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'))), target = join(modules, name);
  dependencies[relative(application, target)] = pkg.version;
  cpSync(root, target, { recursive: true, dereference: true, filter: source => source !== join(root, 'node_modules') });
  for (const dependency of Object.keys(pkg.dependencies ?? {})) copyDependency(dependency, root, join(target, 'node_modules'), new Set([...ancestors, root]));
}
const roots = new Set();
function imports(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) imports(path);
    else if (path.endsWith('.mjs')) for (const match of readFileSync(path, 'utf8').matchAll(/\bfrom\s+['"]([^.'"][^'"]+)['"]/g)) {
      const spec = match[1];
      if (!spec.startsWith('node:')) roots.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
}
imports(join(repo, 'src'));
for (const name of roots) copyDependency(name, repo);
const shell = (stop = false) => `#!/bin/sh\ncd "$(dirname "$0")${process.platform === 'darwin' ? '/Agent Team.app/Contents/Resources/application' : ''}" || exit 1\nexec ./runtime/node --disable-warning=ExperimentalWarning ./src/launcher.mjs${stop ? ' --stop' : ''} "$@"\n`;
const windows = (stop = false) => `@echo off\r\ncd /d "%~dp0"\r\n"runtime\\node.exe" --disable-warning=ExperimentalWarning "src\\launcher.mjs"${stop ? ' --stop' : ''} %*\r\nif errorlevel 1 pause\r\n`;
for (const stop of [false, true]) {
  const name = `${stop ? '停止' : '启动'} Agent Team${process.platform === 'win32' ? '.cmd' : process.platform === 'darwin' ? '.command' : '.sh'}`;
  writeFileSync(join(output, name), process.platform === 'win32' ? windows(stop) : shell(stop));
  chmodSync(join(output, name), 0o755);
  if (process.platform === 'darwin' && !stop) {
    // A native launch entry only; the product UI remains entirely in the browser.
    const bundle = join(output, 'Agent Team.app', 'Contents');
    mkdirSync(join(bundle, 'MacOS'), { recursive: true });
    writeFileSync(join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>AgentTeam</string><key>CFBundleIdentifier</key><string>local.agent-team.${stop ? 'stop' : 'launch'}</string><key>CFBundleName</key><string>Agent Team</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
    writeFileSync(join(bundle, 'MacOS', 'AgentTeam'), `#!/bin/sh\ncd "$(dirname "$0")/../Resources/application" || exit 1\nexec ./runtime/node --disable-warning=ExperimentalWarning ./src/launcher.mjs${stop ? ' --stop' : ''} "$@"\n`);
    chmodSync(join(bundle, 'MacOS', 'AgentTeam'), 0o755);
  }
}
writeFileSync(join(output, '使用说明.txt'), '启动：打开“启动 Agent Team”，浏览器自动打开。关闭网页不会停止工作。\n退出：使用页面设置中的“停止本地服务”，或打开“停止 Agent Team”。\n升级：先停止服务，再替换整个程序目录；用户数据独立保存，不要删除应用数据目录。旧版本降级不保证数据兼容。\n宿主登录、模型和额度由对应宿主管理。\n');
writeFileSync(join(application, 'release.json'), JSON.stringify({ version, platform: process.platform, arch: process.arch, node: process.version, nodeSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'), dependencies }, null, 2));
console.log(`发行目录：${output}`);
