const string = { type: 'string', minLength: 1, maxLength: 48000 };
const definitions = [
  ['send', '给一位成员发送任务、汇报或审查消息。发给主 Agent时进入统一调度会话。是否回复由正文说明。', { to: string, text: string, workItemId: string }, ['to', 'text']],
  ['note', '给一位成员留言，不唤醒，随下一条正式消息交付。', { to: string, text: string, workItemId: string }, ['to', 'text']],
  ['read', '按需读取本群共享消息；用户私聊不在此记录。after 是消息序号游标。', { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, sender: string }, []],
  ['members', '读取本群成员与能力自述。', {}, []],
  ['profile_set', '只更新自己的能力自述，不可代写他人自述。', { text: string }, ['text']],
  ['group_add', '主 Agent 提议添加成员；框架会向正在聊天的用户请求确认。必须从模型目录选择该角色的模型和思考强度。', {
    name: string,
    host: string,
    model_provider: string,
    model: string,
    reasoning_effort: string,
  }, ['name', 'host', 'model', 'reasoning_effort']],
  ['group_remove', '主 Agent 移除成员；立即撤销框架访问并尽力停止相关会话。', { member: string }, ['member']],
  ['group_delete', '主 Agent 删除本群；框架会先请求用户确认。宿主历史与用户私聊保留。', {}, []],
  ['group_create', '主 Agent 提议建群；用户确认后建立。members 可选，格式 名称=宿主,名称=宿主。model_mode为smart|user，model_rules为自然语言模型策略。', {
    name: string,
    workspace: string,
    members: string,
    model_mode: string,
    model_rules: string,
    roles: string,
  }, ['name', 'workspace']],
  ['groups', '主 Agent 列出自己可见的群。', {}, []],
  ['model_catalog', '读取当前实时模型目录。只能从返回目录中选择模型和思考强度。', {}, []],
  ['collaboration_read', '读取本群有效契约、工作项、审查与接受、待用户决定及运行状态；records通过after分页。', { after: { type: 'integer', minimum: 0 } }, []],
  ['work_item_update', '主 Agent管理工作项。command是JSON：创建含title,purpose,standard,participants[{memberId,role:executor|collaborator|reviewer}],policy,allowShell,reviewRequired；policy为该项实际最高访问需求，允许命令须同时由契约授权；reviewer运行时自动收窄为只读。更新含id,itemRevision,state,note。证据evidence是汇报messageId数组；artifact为确定成果版本；reviews为[{messageId,artifact}]。状态pending→in_progress→pending_decision→accepted；blocked/返工/重开回in_progress。每次读取当前revision，使用唯一operationId。', { command: string, revision: { type: 'integer', minimum: 1 }, operationId: string }, ['command', 'revision', 'operationId']],
  ['contract_change_request', '提出契约变更，等待用户批准。contract为完整契约JSON，不能自行批准。', { contract: string, reason: string }, ['contract', 'reason']],
  ['next_goal_request', '当前目标结束且群仍在运行时，提出下一版完整目标契约，等待用户批准。聊天不会自动创建目标。', { contract: string, reason: string }, ['contract', 'reason']],
  ['team_finish', '完成当前目标。command为JSON:{outcome:"completed",final:最终交付,note:理由,coverage:{c1:[已接受工作项ID]},dispositions:[{messageId,reason}]}。先通知成员收束；未处理消息需给出处理理由。工具先返回closing，实际停止后目标才完成。完成后群仍可继续沟通，但不会自动重新派工。', { command: string, revision: { type: 'integer', minimum: 1 }, operationId: string }, ['command', 'revision', 'operationId']],
  ['finish_withdraw', '撤回尚未完成的收尾请求，记录理由后恢复工作，契约不变。', { reason: string }, ['reason']],
];
const preparationDefinitions = [
  ['preparation_read', '读取当前建群准备记录和契约草案。', {}, []],
  ['contract_propose', '提出完整契约草案，等待用户确认，不会创建团队。contract为JSON，字段goal,scope,boundary,confirmation,delivery文本，criteria文本数组，policy为communication|read-only|workspace-write。', { contract: string, revision: { type: 'integer', minimum: 0 } }, ['contract', 'revision']],
  ['model_catalog', '读取当前实时模型目录。必须只从返回目录中选择普通角色的模型和思考强度。', {}, []],
  ['team_plan_update', '为所有普通角色提交最终模型计划。roles是JSON数组，每项包含name、model_provider、model、reasoning_effort；主 Agent不在此计划中。', {
    roles: string,
    revision: { type: 'integer', minimum: 0 },
  }, ['roles', 'revision']],
];
export function toolsFor(role, context = 'coordination') {
  const source = role === 'preparation' ? preparationDefinitions : definitions.filter(([name], i) => {
    if (context === 'profile') return ['members', 'profile_set'].includes(name);
    if (context === 'private') return ['members', 'read', 'collaboration_read', 'model_catalog', ...(role === 'lead' ? ['contract_change_request', 'group_create'] : [])].includes(name);
    return role === 'lead' ? context === 'coordination' || !['work_item_update', 'team_finish', 'finish_withdraw'].includes(name) : i < 5 || name === 'collaboration_read';
  });
  return source.map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
}
export function validateTool(role, name, args, context) {
  const spec = toolsFor(role, context).find(tool => tool.name === name);
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
