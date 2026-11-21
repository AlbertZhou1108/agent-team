const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const LEGACY_MEMBER = new RegExp(`消息\\s+${UUID}\\s+发给成员\\s+${UUID}\\s+的会话失败：`, 'gi');
const LEGACY_PANEL = new RegExp(`消息\\s+${UUID}\\s+发给 Panel Agent 的会话失败：`, 'gi');

/**
 * 早期投递失败通知把消息/成员 UUID 写进了正文。这些是内部标识,对用户只是噪音。
 * 展示时统一换成不含标识的说法;后端已不再推送这类通知(状态改由回执标签承载),
 * 此函数只兜历史消息。
 */
export function tidyNoticeText(text: string): string {
  if (!text) return text;
  return text
    .replace(LEGACY_MEMBER, '发给成员的消息没有送达：')
    .replace(LEGACY_PANEL, '发给 Panel Agent 的消息没有送达：');
}
