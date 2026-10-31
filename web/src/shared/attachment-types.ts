// 附件类型注册表:与 src/attachments.mjs 的服务端注册表保持一致(服务端按扩展名最终判定)。
// 图片经服务端完整校验后走宿主原生图片输入;文本统一 UTF-8 校验后由宿主文件工具读取。

export const ATTACHMENT_IMAGE_TYPES = ['image/png', 'image/jpeg'] as const;

export const ATTACHMENT_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

export const ATTACHMENT_TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.rst', '.json', '.jsonc', '.csv', '.tsv', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.properties', '.env', '.xml', '.html', '.htm', '.css',
  '.scss', '.less', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.py',
  '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.sql', '.r', '.lua', '.pl', '.vim',
  '.proto', '.graphql', '.gradle', '.cmake', '.dart', '.scala', '.log', '.diff', '.patch',
] as const;

export const ATTACHMENT_TEXT_NAMES = [
  'makefile', 'dockerfile', 'license', 'readme', 'changelog', '.gitignore', '.editorconfig', '.npmrc',
] as const;

export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_IMAGE_EXTENSIONS,
  ...ATTACHMENT_TEXT_EXTENSIONS,
].join(',');

/** 按扩展名分类;返回图片 MIME、'text/plain' 或 null(不支持)。 */
export function classifyAttachmentName(name: string): 'image/png' | 'image/jpeg' | 'text/plain' | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const extension = dot > 0 ? lower.slice(dot) : '';
  if ((ATTACHMENT_IMAGE_EXTENSIONS as readonly string[]).includes(extension)) {
    return extension === '.png' ? 'image/png' : 'image/jpeg';
  }
  if ((ATTACHMENT_TEXT_EXTENSIONS as readonly string[]).includes(extension)
    || (ATTACHMENT_TEXT_NAMES as readonly string[]).includes(lower)) {
    return 'text/plain';
  }
  return null;
}

/** 文本预览上限:超过则只提示下载,避免超大文件撑爆对话框。 */
export const TEXT_PREVIEW_LIMIT = 200 * 1024;

export function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
