const string = { type: 'string', minLength: 1, maxLength: 48000 };
const updateText = { type: 'string', minLength: 1, maxLength: 8000 };
const groupId = { type: 'string', minLength: 1, maxLength: 200 };
const readRange = {
  messageId: string,
  hash: string,
  offset: { type: 'integer', minimum: 0 },
  bodyLimit: { type: 'integer', minimum: 1, maximum: 4096 },
};

const observerDefinitions = [
  ['teams_list', '列出当前数据目录中的团队及 Panel Agent 与每个团队的关系。', {}, []],
  ['team_snapshot', '读取一个团队的基础快照、成员、运行状态和沟通状态。', { groupId }, ['groupId']],
  ['team_read', '读取当前团队共享消息；after 是消息序号游标。新会话默认返回有界列表；传入 messageId+hash 可按 Unicode code point 范围展开已列出的正文。', {
    groupId,
    after: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    sender: string,
    ...readRange,
  }, ['groupId']],
  ['team_members', '读取当前团队成员及能力自述。', { groupId }, ['groupId']],
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
  ['team_create', '基于用户明确需求直接创建团队。名称、工作区必填；members 为逗号分隔的 名称=宿主 列表。用户在私人会话中要求建群时使用；创建后当前 Panel Agent 成为该团队主 Agent。', {
    name: string,
    workspace: string,
    members: string,
  }, ['name', 'workspace']],
  ['request_team_takeover', '请求接管一个当前处于观察状态的团队；创建互动卡等待用户在面板上确认，确认后生效。', { groupId }, ['groupId']],
  ['request_team_handback', '请求将当前主控团队交还原主 Agent；创建互动卡等待用户在面板上确认，确认后生效。', { groupId }, ['groupId']],
];

const mainDefinitions = [
  ['team_read', '读取当前团队共享消息；after 是消息序号游标。新会话默认返回有界列表；传入 messageId+hash 可按 Unicode code point 范围展开已列出的正文。', {
    groupId,
    after: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    sender: string,
    ...readRange,
  }, ['groupId']],
  ['team_members', '读取当前团队成员及能力自述。', { groupId }, ['groupId']],
  ['team_send', '以当前团队主 Agent 身份向成员发送正式消息。', {
    groupId,
    to: string,
    text: string,
  }, ['groupId', 'to', 'text']],
  ['team_note', '以当前团队主 Agent 身份向成员留下不唤醒的留言。', {
    groupId,
    to: string,
    text: string,
  }, ['groupId', 'to', 'text']],
  ['group_add', '主 Agent 直接添加普通成员。', {
    groupId,
    name: string,
    host: string,
  }, ['groupId', 'name', 'host']],
  ['group_remove', '主 Agent 移除普通成员。', { groupId, member: string }, ['groupId', 'member']],
  ['ask', '向用户发出互动卡：需要用户明确选择、确认或补充信息时使用。kind=choice 须提供 options（2-8 个选项，确认类事项用 同意/拒绝）；kind=input 请用户填写一段文本。工具立即返回，不等待；发出后结束当前回合，用户的答复会以用户消息自动送达。不要用它提开放性讨论，也不要用普通消息模拟需要用户点击的确认。', {
    kind: { type: 'string', enum: ['choice', 'input'] },
    text: string,
    options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 2, maxItems: 8 },
  }, ['kind', 'text']],
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
  if (context === 'coordination') return schema([...mainDefinitions, ...coordinationUpdateDefinitions]);
  const all = new Map();
  for (const item of [...observerDefinitions, ...preparationDefinitions, ...mainDefinitions]) all.set(item[0], item);
  return schema([...all.values()]);
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
  for (const [key, value] of Object.entries(args)) validateValue(properties[key], value, key);
  return args;
}
