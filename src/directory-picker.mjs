import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
const execute = promisify(execFile);
let picking = false;

export async function chooseDirectory({ platform = process.platform, run = execute } = {}) {
  if (platform !== 'darwin') throw new Error('当前文件夹选择器仅支持 macOS');
  if (picking) throw new Error('文件夹选择窗口已打开');
  picking = true;
  try {
    const script = 'try\nreturn POSIX path of (choose folder with prompt "选择 Panel Agent 私人工作区")\non error number -128\nreturn ""\nend try';
    const { stdout } = await run('/usr/bin/osascript', ['-e', script], { timeout: 120000, maxBuffer: 16384 });
    const path = stdout.replace(/\r?\n$/, '');
    if (!path) return { path: null };
    if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('选择的路径不是有效文件夹');
    return { path };
  } finally { picking = false; }
}
