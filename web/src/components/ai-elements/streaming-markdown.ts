/**
 * 流式渲染时补全/暂留末尾未闭合的 Markdown 定界符（仅用于临时预览，不改原文本），
 * 避免 `**`、`` ` ``、`~~` 或围栏代码块在闭合前以裸符号闪现再突然消失。
 */
export function stabilizeStreamingMarkdown(content: string): string {
  if (!content) return content;

  const fenceMatches = content.match(/(^|\n)[ \t]*```/g);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    return content.endsWith('```')
      ? content.slice(0, -3)
      : `${content}\n\`\`\``;
  }

  const lastBreak = content.lastIndexOf('\n\n');
  const prefix = lastBreak === -1 ? '' : content.slice(0, lastBreak + 2);
  let tail = lastBreak === -1 ? content : content.slice(lastBreak + 2);

  // 忽略成对完整行内代码后的孤立反引号
  const singleTicks = tail.replace(/```+/g, '').match(/`/g);
  if (singleTicks && singleTicks.length % 2 === 1) {
    if (tail.endsWith('`')) return prefix + tail.slice(0, -1);
    return `${prefix}${tail}\``;
  }

  // 剔除行内代码片段后再统计成对加粗/删除线标记，避免误判代码里的符号
  const withoutInlineCode = tail.replace(/`[^`]*`/g, '');

  const boldMatches = withoutInlineCode.match(/\*\*/g);
  if (boldMatches && boldMatches.length % 2 === 1) {
    if (tail.endsWith('**')) tail = tail.slice(0, -2);
    else tail += '**';
  }

  const strikeMatches = tail.replace(/`[^`]*`/g, '').match(/~~/g);
  if (strikeMatches && strikeMatches.length % 2 === 1) {
    if (tail.endsWith('~~')) tail = tail.slice(0, -2);
    else tail += '~~';
  }

  return prefix + tail;
}
