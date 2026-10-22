const string = { type: 'string', minLength: 1, maxLength: 48000 };
const updateText = { type: 'string', minLength: 1, maxLength: 8000 };
const groupId = { type: 'string', minLength: 1, maxLength: 200 };
const cancellation = {
  type: 'object',
  description: '取消工作项时必须提供。kind=covered 时 by 填当前目标下其他已接受工作项；kind=irrelevant 表示该工作项与目标无关。',
  properties: {
    kind: { type: 'string', enum: ['covered', 'irrelevant'] },
    reason: string,
    by: { type: 'array', items: string, minItems: 1 },
  },
  required: ['kind', 'reason'],
  additionalProperties: false,
};
const workItemCommand = {
  type: 'object',
  description: [
    '工作项命令对象，不要传扁平字段。',
    '新建：省略 id，state 必须为 pending，并提供 title、purpose、standard、participants。',
    '更新：提供 id、itemRevision 和要修改的字段；状态必须走 pending→in_progress→pending_decision→accepted。',
    '取消：state=cancelled，且必须提供 cancellation:{kind:"irrelevant"|"covered",reason,by?}。',
    '禁止为了探测参数而创建临时工作项或修改真实工作项。',
  ].join(' '),
  properties: {
    id: string,
    itemRevision: { type: 'integer', minimum: 1 },
    state: {
      type: 'string',
      enum: ['pending', 'in_progress', 'blocked', 'pending_decision', 'accepted', 'cancelled'],
    },
    note: string,
    title: string,
    purpose: string,
    standard: string,
    participants: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          memberId: string,
          role: { type: 'string', enum: ['executor', 'collaborator', 'reviewer'] },
        },
        required: ['memberId', 'role'],
        additionalProperties: false,
      },
    },
    policy: { type: 'string', enum: ['communication', 'read-only', 'workspace-write'] },
    allowShell: { type: 'boolean' },
    reviewRequired: { type: 'boolean' },
    artifact: { type: ['string', 'null'] },
    evidence: { type: 'array', items: string },
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          messageId: string,
          artifact: string,
        },
        required: ['messageId', 'artifact'],
        additionalProperties: false,
      },
    },
    cancellation,
  },
  additionalProperties: false,
};
const finishCommand = {
  type: 'object',
  description: [
    '团队收尾命令对象。outcome 必须为 completed。',
    'coverage 必须逐一列出契约中的每个 criterion id，并引用当前目标中已接受的工作项。',
    'dispositions 必须覆盖所有未处理正式消息。',
  ].join(' '),
  properties: {
    outcome: { type: 'string', enum: ['completed'] },
    final: string,
    note: string,
    coverage: {
      type: 'object',
      additionalProperties: { type: 'array', items: string, minItems: 1 },
    },
    dispositions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          messageId: string,
          reason: string,
        },
        required: ['messageId', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['outcome', 'final', 'note', 'coverage'],
  additionalProperties: false,
};

const observerDefinitions = [
  ['teams_list', '列出当前数据目录中的团队及 Panel Agent 与每个团队的关系。', {}, []],
  ['team_snapshot', '读取一个团队的基础快照、成员、运行状态和协作摘要。', { groupId }, ['groupId']],
  ['team_read', '读取当前团队共享消息；after 是消息序号游标。', {
    groupId,
    after: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    sender: string,
  }, ['groupId']],
  ['team_members', '读取当前团队成员及能力自述。', { groupId }, ['groupId']],
  ['team_collaboration_read', '读取当前团队的契约、目标、工作项、审查、接受和运行状态。', {
    groupId,
    after: { type: 'integer', minimum: 0 },
  }, ['groupId']],
  ['goal_draft_read', '读取Team状态、Goal Draft、Goal Queue、Current Goal和历史Goal。', { groupId }, ['groupId']],
  ['team_message_trace', '读取一条团队消息的真实来源和输入回合。', {
    groupId,
    messageId: string,
  }, ['groupId', 'messageId']],
  ['team_turn_trace', '读取一个公开团队回合的事件和模型观测。', {
    groupId,
    turnId: string,
    after: { type: 'integer', minimum: 0 },
  }, ['groupId', 'turnId']],
  ['model_catalog', '读取当前实时模型目录。', {}, []],
];

const preparationDefinitions = [
  ['team_preparation_create', '基于用户明确需求创建团队准备记录，不创建团队。', {
    name: string,
    workspace: string,
    members: string,
  }, ['name', 'workspace']],
  ['preparation_read', '读取团队准备记录、契约草案和角色模型计划。', {
    preparationId: string,
  }, ['preparationId']],
  ['contract_propose', '提交完整契约草案并生成新的 revision/hash。', {
    preparationId: string,
    contract: string,
    revision: { type: 'integer', minimum: 0 },
  }, ['preparationId', 'contract', 'revision']],
  ['team_plan_update', '提交团队普通角色的完整模型计划。', {
    preparationId: string,
    roles: string,
    revision: { type: 'integer', minimum: 0 },
  }, ['preparationId', 'roles', 'revision']],
  ['request_team_takeover', '请求接管一个当前处于观察状态的团队；必须等待用户确认。', { groupId }, ['groupId']],
  ['request_team_handback', '请求将当前主控团队交还原主 Agent；必须等待用户确认。', { groupId }, ['groupId']],
];

const mainDefinitions = [
  ['team_read', '读取当前团队共享消息；after 是消息序号游标。', {
    groupId,
    after: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    sender: string,
  }, ['groupId']],
  ['team_members', '读取当前团队成员及能力自述。', { groupId }, ['groupId']],
  ['team_collaboration_read', '读取当前团队协作状态。', {
    groupId,
    after: { type: 'integer', minimum: 0 },
  }, ['groupId']],
  ['goal_draft_read', '读取Team状态、Goal Draft、Goal Queue、Current Goal和历史Goal。', { groupId }, ['groupId']],
  ['goal_draft_create', '创建Goal Draft，等待用户确认。contract为完整契约JSON，requiredMemberIds为逗号分隔的成员ID。', {
    groupId,
    contract: string,
    requiredMemberIds: string,
    revision: { type: 'integer', minimum: 1 },
    operationId: string,
  }, ['groupId', 'contract', 'revision', 'operationId']],
  ['goal_draft_update', '修改尚未确认的Goal Draft并生成新的revision/hash。', {
    groupId,
    draftId: string,
    draftRevision: { type: 'integer', minimum: 1 },
    contract: string,
    requiredMemberIds: string,
    revision: { type: 'integer', minimum: 1 },
    operationId: string,
  }, ['groupId', 'draftId', 'draftRevision', 'contract', 'revision', 'operationId']],
  ['team_send', '以当前团队主 Agent 身份向成员发送正式任务、汇报或审查消息。', {
    groupId,
    to: string,
    text: string,
    workItemId: string,
  }, ['groupId', 'to', 'text']],
  ['team_note', '以当前团队主 Agent 身份向成员留下不唤醒的留言。', {
    groupId,
    to: string,
    text: string,
    workItemId: string,
  }, ['groupId', 'to', 'text']],
  ['work_item_update', '主 Agent 管理工作项。command 必须是结构化对象；取消时必须使用 cancellation.kind 和 cancellation.reason。', {
    groupId,
    command: workItemCommand,
    revision: { type: 'integer', minimum: 1 },
    operationId: string,
  }, ['groupId', 'command', 'revision', 'operationId']],
  ['contract_change_request', '提出当前团队的契约变更，等待用户批准。', {
    groupId,
    contract: string,
    reason: string,
  }, ['groupId', 'contract', 'reason']],
  ['next_goal_request', '提出当前团队的下一版完整目标契约。', {
    groupId,
    contract: string,
    reason: string,
  }, ['groupId', 'contract', 'reason']],
  ['team_finish', '请求完成当前团队目标。command 必须是含 outcome、final、note 和 coverage 的结构化对象。', {
    groupId,
    command: finishCommand,
    revision: { type: 'integer', minimum: 1 },
    operationId: string,
  }, ['groupId', 'command', 'revision', 'operationId']],
  ['finish_withdraw', '撤回尚未完成的团队收尾请求。', { groupId, reason: string }, ['groupId', 'reason']],
  ['group_add', '主 Agent 提议添加普通成员，等待用户决定。', {
    groupId,
    name: string,
    host: string,
  }, ['groupId', 'name', 'host']],
  ['group_remove', '主 Agent 移除普通成员。', { groupId, member: string }, ['groupId', 'member']],
  ['model_catalog', '读取当前实时模型目录。', {}, []],
];

const coordinationUpdateDefinitions = [
  ['panel_update_publish', [
    '向 Panel Agent 私人会话发布一条团队更新。',
    'text 由 Agent 自由填写自然语言，应自包含地说明团队成员或事件、当前状态，以及是否需要用户操作。',
    '只在本回合确实有值得用户知道的信息时调用；无需用户知道的内部交流可以不调用。',
    '发布后由框架持久化，并在 coordination 回合结束后自动交给私人会话；私人会话忙碌时排队。',
  ].join(' '), {
    text: updateText,
  }, ['text']],
];

function schema(source) {
  return source.map(([name, description, properties, required]) => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  }));
}

export function panelToolsFor(context) {
  if (context === 'preparation') return schema([...observerDefinitions, ...preparationDefinitions]);
  if (context === 'coordination') return schema([...mainDefinitions, ...coordinationUpdateDefinitions]);
  const all = new Map();
  for (const item of [...observerDefinitions, ...preparationDefinitions, ...mainDefinitions]) all.set(item[0], item);
  return schema([...all.values()]);
}

export function panelCommandObject(value, name = 'command') {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${name}必须是JSON对象或JSON对象字符串`);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name}必须是JSON对象`);
  }
  return parsed;
}

function validateValue(rule, value, path) {
  if (!rule) return;
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  if (rule.type) {
    const valid = types.some(type => {
      if (type === 'null') return value === null;
      if (type === 'array') return Array.isArray(value);
      if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
      if (type === 'integer') return Number.isInteger(value);
      return typeof value === type;
    });
    if (!valid) throw new Error(`${path}类型无效`);
  }
  if (rule.enum && !rule.enum.includes(value)) throw new Error(`${path}必须是以下值之一: ${rule.enum.join(', ')}`);
  if (Object.hasOwn(rule, 'const') && value !== rule.const) throw new Error(`${path}必须为${rule.const}`);
  if (typeof value === 'string') {
    if (rule.minLength !== undefined && value.trim().length < rule.minLength) throw new Error(`${path}需要非空文本`);
    if (rule.maxLength !== undefined && value.length > rule.maxLength) throw new Error(`${path}文本过长`);
  }
  if (typeof value === 'number') {
    if (rule.minimum !== undefined && value < rule.minimum) throw new Error(`${path}不能小于${rule.minimum}`);
    if (rule.maximum !== undefined && value > rule.maximum) throw new Error(`${path}不能大于${rule.maximum}`);
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) throw new Error(`${path}至少需要${rule.minItems}项`);
    if (rule.items) value.forEach((item, index) => validateValue(rule.items, item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = rule.properties ?? {};
    for (const key of rule.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}为必填项`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateValue(properties[key], item, `${path}.${key}`);
      else if (rule.additionalProperties === false) throw new Error(`${path}不允许字段: ${key}`);
      else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') {
        validateValue(rule.additionalProperties, item, `${path}.${key}`);
      }
    }
  }
}

export function validatePanelTool(context, name, args) {
  const tool = panelToolsFor(context).find(candidate => candidate.name === name);
  if (!tool) throw new Error('Panel Agent 当前上下文不能使用此工具');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象');
  const properties = tool.inputSchema.properties;
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) throw new Error(`不允许的参数: ${key}`);
  for (const key of tool.inputSchema.required) if (!Object.hasOwn(args, key)) throw new Error(`缺少参数: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    const normalized = rule.type === 'object' ? panelCommandObject(value, key) : value;
    validateValue(rule, normalized, key);
  }
  return args;
}
