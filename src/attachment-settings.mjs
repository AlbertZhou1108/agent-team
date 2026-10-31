// 附件上传设置:首期只有三个全局配置项,专用 attachment_settings 单行表存储。
// 校验与序列化集中在这里,HTTP、上传和消息提交共用同一份值;不建设通用配置系统。

export const DEFAULT_ATTACHMENT_SETTINGS = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,
  maxFilesPerMessage: 4,
  maxImagePixels: 20_000_000,
});

// 上限只是防呆:默认值不是已验证的宿主上限,但设置值必须是能落库、有意义的正整数。
export const ATTACHMENT_SETTINGS_LIMITS = Object.freeze({
  maxFileBytes: 2 ** 31 - 1,
  maxFilesPerMessage: 100,
  maxImagePixels: 2 ** 31 - 1,
});

const ATTACHMENT_SETTINGS_LIMITS_SIZE = Object.keys(ATTACHMENT_SETTINGS_LIMITS).length;

// POST 必须同时收到三个正整数字段;字段名不匹配(缺失或多余)、缺失整数时抛错,由路由转 400。
export function normalizeAttachmentSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('附件设置格式不正确');
  const keys = Object.keys(value);
  if (keys.length !== ATTACHMENT_SETTINGS_LIMITS_SIZE || keys.some(key => !(key in ATTACHMENT_SETTINGS_LIMITS))) {
    throw new Error('附件设置字段不完整或不匹配');
  }
  const normalized = {};
  for (const [key, limit] of Object.entries(ATTACHMENT_SETTINGS_LIMITS)) {
    const raw = value[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
      throw new Error(`附件设置 ${key} 必须是正整数`);
    }
    if (raw > limit) throw new Error(`附件设置 ${key} 超过上限 ${limit}`);
    normalized[key] = raw;
  }
  return normalized;
}

export function serializeAttachmentSettings(row) {
  return {
    maxFileBytes: row.max_file_bytes,
    maxFilesPerMessage: row.max_files,
    maxImagePixels: row.max_image_pixels,
    updated: row.updated ?? null,
  };
}
