// 跨平台私有目录与文件权限收紧:
// - POSIX 用 chmodSync(0o700 / 0o600) 限制同机其他用户访问;
// - Windows 上 chmod 只切只读属性不改 ACL,因此对数据根目录提供异步、尽力而为的
//   icacls ACL 收紧(仅保留当前用户与 SYSTEM 完全控制),失败不阻断启动。
import { execFile } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';

/** 收紧私有文件权限(POSIX 0600;Windows 依赖所在用户目录 ACL)。 */
export function restrictPrivateFile(filePath, { platform = process.platform } = {}) {
  if (platform === 'win32') return;
  chmodSync(filePath, 0o600);
}

/** 收紧私有目录权限(POSIX 0700;Windows 依赖目录 ACL,必要时辅以 hardenPrivateDirectoryAcl)。 */
export function restrictPrivateDirectory(directory, { platform = process.platform } = {}) {
  if (platform === 'win32') return;
  chmodSync(directory, 0o700);
}

/**
 * 构造 Windows icacls 参数:关闭继承并仅授予当前用户与 SYSTEM 完全控制。
 * 纯函数便于单元测试;拿不到当前用户名时返回 null(跳过)。
 */
export function windowsPrivateAclArgs(directory, env = process.env) {
  const user = env?.USERNAME?.trim();
  if (!user) return null;
  const principal = env?.USERDOMAIN?.trim() ? `${env.USERDOMAIN.trim()}\\${user}` : user;
  return [
    directory,
    '/inheritance:r',
    '/grant:r', `${principal}:(OI)(CI)F`,
    '/grant:r', '*S-1-5-18:(OI)(CI)F',
  ];
}

function isUnderTempDir(directory, tempRoot = tmpdir()) {
  const rel = relative(resolve(tempRoot).toLowerCase(), resolve(directory).toLowerCase());
  return Boolean(rel) && !rel.startsWith('..') && rel !== resolve(directory).toLowerCase();
}

/**
 * 异步收紧 Windows 持久化数据根目录 ACL(不阻塞启动、失败静默降级)。
 * 跳过系统临时目录(避免短生命周期测试目录清理时与 icacls 句柄竞态,且用户 TEMP 本身已隔离)。
 * POSIX 平台无操作(同步 chmodSync 0700 已在建目录时完成)。
 */
export function hardenPrivateDirectoryAcl(directory, {
  platform = process.platform,
  env = process.env,
  run = execFile,
  tempRoot = tmpdir(),
} = {}) {
  if (platform !== 'win32') return Promise.resolve(false);
  if (isUnderTempDir(directory, tempRoot)) return Promise.resolve(false);
  const args = windowsPrivateAclArgs(directory, env);
  if (!args) return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      const child = run('icacls.exe', args, { windowsHide: true, timeout: 5000 }, error => {
        resolve(!error);
      });
      child?.unref?.();
    } catch {
      resolve(false);
    }
  });
}
