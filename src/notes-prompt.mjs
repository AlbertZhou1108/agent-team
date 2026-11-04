// 随心记 → Panel Agent 的提示词模板。
//
// 这里只有字符串拼装，不做 IO，也不读数据库：措辞就是产品行为，集中一处便于契约测试锁住。
// 模板的核心是「先判断、后建议」——默认假设用户已经想清楚，只在真的做不对时才提，
// 并且强制 A/B/C 三支互斥，避免模型输出「先夸一遍再挑几条」的长回复。
const HEADER = '【随心记】先读懂这条记录，再判断它现在能不能做';

function todoLine(item) {
  return `${item.done ? '- [x]' : '- [ ]'} ${item.text}`;
}

function hasFence(body) {
  return body.includes('```');
}

export function notePrompt(note, { instruction = '' } = {}) {
  const lines = [HEADER, '', `标题：${note.title}`, '', '正文：', note.body];
  const todos = Array.isArray(note.todos) ? note.todos : [];
  if (todos.length) lines.push('', '待办：', ...todos.map(todoLine));
  if (note.due) lines.push('', `截止：${note.due}`);
  const extra = typeof instruction === 'string' ? instruction.trim() : '';
  if (extra) lines.push('', `补充要求：${extra}`);
  lines.push(
    '',
    '请按这个顺序处理：',
    '',
    '1. 读：这条记录想解决什么问题，做成什么样算完成，有哪些前提。',
    '2. 看：结合当前工作区的实际情况判断可行性。涉及具体项目或代码的，先读文件确认现状，不要凭印象假设；确认不了就说明这是你的假设。',
    '3. 判断，并且只做一个判断：',
    '   A. 已经清楚、可以直接做 —— 不要为了挑毛病而挑毛病。用两三句话说清你打算怎么做（做法、影响范围、风险），然后问我是否开始实施。',
    '   B. 大致清楚，但有会直接影响做对与否的点 —— 只列这些点，每条给出你的建议做法；只有一个就只说一个，不要凑数。我确认后再动手。',
    '   C. 关键信息缺失，判断不了 —— 只问必须由我回答的问题，能自己查到的不要问，也不要替我猜。',
    '4. 只有选 B 时才给「完善后的版本」，用代码块包住标题/正文/待办，方便我复制回笔记；A 和 C 不要输出改写版本。',
    '',
    '需要我做决定时用互动卡问我（选 A 时问：开始实施 / 先补充 / 暂时不做）。',
    '在我明确同意之前，不要开始执行，也不要改文件。',
  );
  if (hasFence(note.body)) lines.push('', '正文里已经有代码块，你输出的代码块请用四个反引号包裹，避免嵌套冲突。');
  return lines.join('\n');
}
