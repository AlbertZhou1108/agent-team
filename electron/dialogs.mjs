/**
 * 目录选择对话框的返回处理。抽成纯函数，让返回值链路不依赖模态窗口也能测。
 * showDialog 由调用方注入（真实环境是 dialog.showOpenDialog）。
 */
export async function pickDirectory(showDialog, options) {
  const result = await showDialog(options);
  if (result?.canceled || !result?.filePaths?.length) return { path: null };
  return { path: result.filePaths[0] };
}
