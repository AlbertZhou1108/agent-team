import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
const execute = promisify(execFile);
let picking = false;

export async function chooseDirectory({ platform = process.platform, run = execute } = {}) {
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error('当前系统不支持文件夹选择器');
  if (picking) throw new Error('文件夹选择窗口已打开');
  picking = true;
  try {
    const script = 'try\nreturn POSIX path of (choose folder with prompt "选择 Panel Agent 私人工作区")\non error number -128\nreturn ""\nend try';
    const options = { timeout: 120000, maxBuffer: 16384, windowsHide: true };
    let stdout;
    if (platform === 'darwin') {
      ({ stdout } = await run('/usr/bin/osascript', ['-e', script], options));
    } else if (platform === 'win32') {
      const command = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "选择 Panel Agent 私人工作区"; try { if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($picker.SelectedPath) } } finally { $picker.Dispose() }';
      ({ stdout } = await run('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], options));
    } else {
      try {
        ({ stdout } = await run('zenity', ['--file-selection', '--directory', '--title=选择 Panel Agent 私人工作区'], options));
      } catch (error) {
        if (error.code === 1) return { path: null };
        if (error.code !== 'ENOENT') throw error;
        try {
          ({ stdout } = await run('kdialog', ['--getexistingdirectory', process.cwd(), '--title', '选择 Panel Agent 私人工作区'], options));
        } catch (fallback) {
          if (fallback.code === 1) return { path: null };
          if (fallback.code === 'ENOENT') throw new Error('文件夹选择器需要 zenity 或 kdialog；也可以手动输入工作区路径');
          throw fallback;
        }
      }
    }
    const path = stdout.replace(/\r?\n$/, '');
    if (!path) return { path: null };
    if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('选择的路径不是有效文件夹');
    return { path };
  } finally { picking = false; }
}
