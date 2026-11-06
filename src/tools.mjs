import { validateToolValue } from './tool-schema.mjs';
import { askInputProperties } from './tool-ops.mjs';

const string = { type: 'string', minLength: 1, maxLength: 48000 };
const definitions = [
  ['send', '给一位成员发送消息。发给主 Agent时进入统一调度会话。需要对方答复或确认时设置 expects_reply=true；答复某条请求时用 reply_to 填原消息 ID。普通汇报、通知不要设置。', {
    to: string,
    text: string,
    expects_reply: { type: 'boolean' },
    reply_to: { type: 'string', minLength: 1, maxLength: 100 },
  }, ['to', 'text']],
  ['note', '给一位成员留言，不唤醒，随下一条正式消息交付。', { to: string, text: string }, ['to', 'text']],
  ['read', '按需读取本群共享消息；用户私聊不在此记录。after 是消息序号游标，只返回 seq 大于 after 的消息（不含该序号本身）；续读把上一次返回的 nextAfter 原样传入 after，不要自行推算序号。新会话默认返回有界列表（ID/seq/作者/接收者/kind/ref/预览）；传入 messageId+hash 可按 Unicode code point 范围展开已列出的正文。', {
    after: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    sender: string,
    messageId: string,
    hash: string,
    offset: { type: 'integer', minimum: 0 },
    bodyLimit: { type: 'integer', minimum: 1, maximum: 4096 },
  }, []],
  ['members', '读取本群成员与能力自述。', {}, []],
  ['profile_set', '只更新自己的能力自述，不可代写他人自述。', { text: string }, ['text']],
  ['ask', '向用户发出互动卡：需要用户明确选择、确认或补充信息时使用。单问用 kind=choice（须提供 options，2-8 个选项，确认类事项用 同意/拒绝）或 kind=input（请用户填写一段文本）；需要用户连续确认多件事时改用 steps 一次发出 2-8 步，面板用一张卡片逐步作答，全部答完才把汇总答复送回。工具立即返回，不等待；发出后结束当前回合，用户的答复会以用户消息（sender=user）自动送达。不要用它提开放性讨论，也不要用普通消息模拟需要用户点击的确认。', askInputProperties, []],
  ['group_add', '主 Agent 请求添加成员；创建互动卡等待用户在面板上确认，同意后生效。', {
    name: string,
    host: string,
  }, ['name', 'host']],
  ['group_remove', '主 Agent 移除成员；立即撤销框架访问并尽力停止相关会话。', { member: string }, ['member']],
  ['group_delete', '主 Agent 删除本群；框架会创建互动卡请求用户确认，同意后生效。项目工作文件、宿主原生历史及 Panel Agent 私人聊天保留；本群框架会话记录删除。', {}, []],
  ['group_create', '主 Agent 创建一个新团队并担任其主 Agent；创建互动卡等待用户在面板上确认，同意后生效。members 可选，格式 名称=宿主,名称=宿主。', {
    name: string,
    workspace: string,
    members: string,
  }, ['name', 'workspace']],
  ['groups', '主 Agent 列出自己可见的群。', {}, []],
  ['model_catalog', '读取当前实时模型目录。', {}, []],
  ['tasks_set', '把自己当前的任务列表整体写到团队任务面板（不阻塞任何流程）。tasks 为全量替换：每条 {text, state}，state 为 doing（进行中）/done（已完成）/dropped（已放弃）；开始、推进或完成工作时更新，空数组清空自己的任务。', {
    tasks: {
      type: 'array',
      minItems: 0,
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 500 },
          state: { type: 'string', enum: ['doing', 'done', 'dropped'] },
        },
      },
    },
  }, ['tasks']],
  ['member_model', '主 Agent 为普通成员申请调整模型配置；只能选 model_catalog 实时目录中真实存在的模型与受支持的思考强度，model 留空表示恢复宿主默认。创建互动卡等待用户在面板上确认，同意后生效，成员下一回合起使用新配置。', {
    member: string,
    model_provider: string,
    model: string,
    reasoning_effort: string,
  }, ['member']],
];
export function toolsFor(role, context = 'coordination') {
  const source = definitions.filter(([name], i) => {
    if (context === 'profile') return ['members', 'profile_set'].includes(name);
    if (context === 'private') return ['members', 'read', 'model_catalog', ...(role === 'lead' ? ['group_create'] : [])].includes(name);
    return role === 'lead' || i < 5 || name === 'ask' || name === 'tasks_set';
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
  for (const [key, value] of Object.entries(args)) validateToolValue(schema.properties[key], value, key);
  return args;
}
