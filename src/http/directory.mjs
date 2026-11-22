import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
const execute = promisify(execFile);
let picking = false;

function abortError(signal) {
  const error = new Error('文件夹选择已取消');
  error.name = 'AbortError';
  if (signal?.reason !== undefined) error.cause = signal.reason;
  return error;
}

function appleScriptText(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function powerShellText(value) {
  return value.replace(/[`"$]/g, character => `\`${character}`);
}

export async function chooseDirectory({ platform = process.platform, run = execute, signal, prompt = '选择工作区文件夹' } = {}) {
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error('当前系统不支持文件夹选择器');
  if (signal?.aborted) throw abortError(signal);
  if (picking) throw new Error('文件夹选择窗口已打开');
  picking = true;
  try {
    const title = String(prompt).replace(/[\r\n]+/g, ' ').trim() || '选择工作区文件夹';
    const script = `try\nreturn POSIX path of (choose folder with prompt "${appleScriptText(title)}")\non error number -128\nreturn ""\nend try`;
    const options = { timeout: 120000, maxBuffer: 16384, windowsHide: true, ...(signal ? { signal } : {}) };
    let stdout;
    if (platform === 'darwin') {
      ({ stdout } = await run('/usr/bin/osascript', ['-e', script], options));
    } else if (platform === 'win32') {
      const command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "${powerShellText(title)}"; try { if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($picker.SelectedPath) } } finally { $picker.Dispose() }`;
      ({ stdout } = await run('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], options));
    } else {
      try {
        ({ stdout } = await run('zenity', ['--file-selection', '--directory', `--title=${title}`], options));
      } catch (error) {
        if (error.code === 1) return { path: null };
        if (error.name === 'AbortError' || signal?.aborted) throw abortError(signal);
        if (error.code !== 'ENOENT') throw error;
        try {
          ({ stdout } = await run('kdialog', ['--getexistingdirectory', process.cwd(), '--title', title], options));
        } catch (fallback) {
          if (fallback.code === 1) return { path: null };
          if (fallback.name === 'AbortError' || signal?.aborted) throw abortError(signal);
          if (fallback.code === 'ENOENT') throw new Error('文件夹选择器需要 zenity 或 kdialog；也可以手动输入工作区路径', { cause: fallback });
          throw fallback;
        }
      }
    }
    const path = stdout.replace(/\r?\n$/, '');
    if (!path) return { path: null };
    if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('选择的路径不是有效文件夹');
    return { path };
  } finally {
    // 模块级单飞锁:并发进入已被上方守卫拦截,复位不依赖读值。
    // eslint-disable-next-line require-atomic-updates
    picking = false;
  }
}
