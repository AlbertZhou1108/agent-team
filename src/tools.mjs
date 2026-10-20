const string = { type: 'string', minLength: 1, maxLength: 48000 };
const definitions = [
  ['send', '给一位成员发送正式消息，唤醒双方独立对话中的接收端。最终文本不会自动发给群。', { to: string, text: string }, ['to', 'text']],
  ['note', '给一位成员留言，不唤醒。用于涉及自己的补充或轻通知，随对方下一条正式消息交付。', { to: string, text: string }, ['to', 'text']],
  ['read', '按需读取本群共享消息；用户私聊不在此记录。after 是消息序号游标。', { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, sender: string }, []],
  ['members', '读取本群成员与能力自述。', {}, []],
  ['profile_set', '只更新自己的能力自述，不可代写他人自述。', { text: string }, ['text']],
  ['group_add', '主 Agent 提议添加成员；框架会向正在聊天的用户请求确认。', { name: string, host: string }, ['name', 'host']],
  ['group_remove', '主 Agent 移除成员；立即撤销框架访问并尽力停止相关会话。', { member: string }, ['member']],
  ['group_delete', '主 Agent 删除本群；框架会先请求用户确认。宿主历史与用户私聊保留。', {}, []],
  ['group_create', '主 Agent 提议建群；用户确认后建立。members 可选，格式 名称=宿主,名称=宿主。返回新群编号，用户可 /use 切换。', { name: string, workspace: string, members: string }, ['name', 'workspace']],
  ['groups', '主 Agent 列出自己可见的群。', {}, []],
];
export function toolsFor(role) {
  return definitions.filter((_, i) => role === 'lead' || i < 5).map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
}
export function validateTool(role, name, args) {
  const spec = toolsFor(role).find(tool => tool.name === name);
  if (!spec) throw new Error('当前成员不可使用此工具');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象');
  const schema = spec.inputSchema;
  for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`不允许的参数: ${key}`);
  for (const key of schema.required) if (!Object.hasOwn(args, key)) throw new Error(`缺少参数: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (rule.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > rule.maxLength)) throw new Error(`无效文本: ${key}`);
    if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > (rule.maximum ?? Number.MAX_SAFE_INTEGER))) throw new Error(`无效整数: ${key}`);
  }
  return args;
}
