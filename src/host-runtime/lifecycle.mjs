import which from 'which';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnHost, stopHost } from './subprocess.mjs';

const packages = { codex: '@openai/codex', dsh: '@deepseek-ai/dsh' };

export function installationPlan(adapter, platform = process.platform, arch = process.arch) {
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error('当前系统或处理器架构暂不支持自动安装');
  }
  if (packages[adapter]) return { command: 'npm', args: ['install', '--global', '--engine-strict', packages[adapter]], kind: 'npm' };
  if (adapter !== 'claude') throw new Error('该适配器不支持自动安装');
  return platform === 'win32'
    ? { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '$ErrorActionPreference = "Stop"; irm https://claude.ai/install.ps1 | iex'], kind: 'native' }
    : { command: 'bash', args: ['-o', 'pipefail', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'], kind: 'native' };
}

export function runCommand(command, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnHost(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let output = '', stderr = '', failure;
    const timer = setTimeout(() => {
      failure = new Error('命令执行超时');
      stopHost(child).catch(reject);
    }, timeout);
    const collect = data => { output = (output + data.toString()).slice(-8000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(stderr.trim() || output.trim() || `命令退出 (${code})`));
      resolve(output.trim());
    });
  });
}

// Each adapter owns its configured command. A successful discovery/installation
// updates that same command so subsequent business calls use the detected binary.
export function createCliLifecycle(adapter, configuredCommand, setCommand, {
  run = runCommand, locate = command => which.sync(command, { nothrow: true }),
  platform = process.platform, arch = process.arch, home = homedir(), exists = existsSync,
} = {}) {
  let installing = null;
  let installation;
  const custom = configuredCommand !== adapter;
  async function findCommand() {
    const found = locate(configuredCommand);
    if (found || custom) return found;
    if (adapter === 'claude') {
      const native = join(home, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude');
      if (exists(native)) return native;
    }
    if (packages[adapter]) {
      const npm = locate('npm');
      if (npm) {
        const prefix = await run(npm, ['prefix', '--global']);
        const candidate = platform === 'win32' ? join(prefix, `${adapter}.cmd`) : join(prefix, 'bin', adapter);
        if (exists(candidate)) return candidate;
      }
    }
    return null;
  }
  async function checkStatus() {
    try {
      const command = await findCommand();
      if (!command) return { status: 'missing', reason: custom ? '未找到配置的自定义命令，请检查宿主配置' : undefined };
      await run(command, ['--version']);
      setCommand(command);
      return { status: 'available' };
    } catch (error) { return { status: 'error', reason: error.message }; }
  }
  async function performInstall() {
    const current = await checkStatus();
    if (current.status === 'available') return current;
    if (current.status !== 'missing') throw new Error('宿主已存在但启动异常，请先解决异常');
    if (custom) throw new Error('自定义命令无法自动安装，请先修正宿主配置');
    const plan = installationPlan(adapter, platform, arch);
    const installer = locate(plan.command);
    if (!installer) throw new Error(`安装需要 ${plan.command}，请先安装并加入 PATH`);
    if (plan.kind === 'native' && platform !== 'win32' && !locate('curl')) throw new Error('安装需要 curl，请先安装并加入 PATH');
    installation = { phase: 'installing' };
    await run(installer, plan.args, 300000);
    installation = { phase: 'verifying' };
    const result = await checkStatus();
    if (result.status !== 'available') throw new Error(result.reason || '安装命令已结束，但未找到可启动的宿主');
    return result;
  }
  return {
    installationStatus: () => ({ installing: Boolean(installing), ...(installation ? { installation: { ...installation } } : {}) }),
    checkStatus: async () => installing
      ? { status: 'missing', installing: true, installation: { ...installation } }
      : { ...await checkStatus(), ...(installation ? { installation: { ...installation } } : {}) },
    install() {
      // Repeated requests share the same operation.
      if (!installing) {
        installation = { phase: 'checking' };
        installing = performInstall().then(result => {
          installation = { phase: 'completed' };
          return { ...result, installation: { ...installation } };
        }, error => {
          installation = { phase: 'failed', reason: error.message };
          throw error;
        }).finally(() => { installing = null; });
      }
      return installing;
    },
  };
}
