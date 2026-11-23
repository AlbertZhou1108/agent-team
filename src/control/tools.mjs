/**
 * 外部主控工具面：工具定义、能力过滤、只读集合与协议状态。
 *
 * 定义本体是纯数据；过滤（elicitation / wake 能力）与 JSON Schema 包装也在此完成，
 * 这里不 import `identity.mjs`（identity → tools 单向依赖，避免循环），
 * elicitation 判定直接内联 `supportsControlCapability`。
 */
import {
  CONTROL_CAPABILITIES,
  CONTROL_PROTOCOL_VERSION,
  supportsControlCapability,
} from '../control-capabilities.mjs';
import { dispatchRequirementProperties } from '../tools/ops.mjs';

export const READ_ONLY_CONTROL_TOOLS = new Set([
  'control_protocol',
  'control_status',
  'control_teams',
  'team_snapshot',
  'team_members',
  'team_read',
  'control_decisions',
]);

export function controlToolDefinitions() {
  const teamId = { type: 'string', minLength: 1, maxLength: 200 };
  const text = { type: 'string', minLength: 1, maxLength: 48000 };
  const memberInput = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      host: { type: 'string', minLength: 1, maxLength: 100 },
      model: { type: 'string', minLength: 1, maxLength: 300 },
      reasoningEffort: { type: 'string', minLength: 1, maxLength: 100 },
      policyCeiling: { type: ['string', 'null'], enum: ['communication', 'read-only', 'workspace-write', null] },
      allowShell: { type: ['boolean', 'null'] },
      allowBrowser: { type: 'boolean' },
      workspaceMode: { type: 'string', enum: ['inherit', 'worktree'] },
    },
    required: ['name', 'host'],
    additionalProperties: false,
  };
  return [
    ['control_protocol', '读取当前 Agent Team 协议、连接能力和无头协作说明。', {}, []],
    ['control_status', '查看当前绑定、能力、团队数量和外部收件箱状态。', {}, []],
    ['control_wake_test', '验证当前 Client binding 能否真实启动一次主动唤醒。验证可能消耗模型额度；成功后 binding 才进入 ready。', {}, []],
    ['control_accept_pull_only', '接受当前 Client binding 使用 Pull-only；作用于该 binding 的所有现有和后续团队，不扩大权限。', {}, []],
    ['control_teams', '列出当前外部主控控制的团队。', {}, []],
    ['team_activate', '把当前 client binding 设为团队 active controller session；同身份其他会话随即只读。', { teamId }, ['teamId']],
    ['control_inbox', '领取待投递给当前外部主控的团队消息；领取表示客户端接受输入，不表示宿主回合已经完成。', {
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, []],
    ['team_create', '以当前外部主控身份创建团队。桌面主控会话省略 workspace，团队跟随会话当前工作目录；CLI 连接必须显式传入且位于绑定的 workspace roots 内。', {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      workspace: { type: 'string', minLength: 1, maxLength: 4096 },
      members: { type: ['array', 'string'], maxLength: 16000, maxItems: 20, items: memberInput },
      charter: { type: 'string', maxLength: 48000 },
      policy: { type: 'string', enum: ['communication', 'read-only', 'workspace-write'] },
      allowShell: { type: 'boolean' },
      workflowTemplate: { type: 'string', enum: ['none', 'standard-dev', 'quick-fix'] },
      operationId: { type: 'string', minLength: 1, maxLength: 128 },
    }, ['name']],
    ['team_snapshot', '读取一个受控团队的基础快照、成员、沟通状态与任务。', { teamId }, ['teamId']],
    ['team_members', '读取受控团队成员、能力自述与只读能力名片（当前模型、modal.image、contextWindow、exec.*、tool.browser 及有效策略）。派工前据此对照目标能力。', { teamId }, ['teamId']],
    ['team_read', '分页读取受控团队共享消息。', {
      teamId,
      after: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      sender: text,
      messageId: text,
      hash: text,
      offset: { type: 'integer', minimum: 0 },
      bodyLimit: { type: 'integer', minimum: 1, maximum: 4096 },
    }, ['teamId']],
    ['team_send', '以当前主控身份向成员发送会唤醒的正式消息。派工前可先读 team_members 的能力名片；需要目标成员具备特定执行能力时传 requiredCapabilities（exec.read/exec.write/exec.shell/modal.image/tool.browser，旧 file.* 自动归一化），需要大上下文模型时传 minContextWindow。写库前与执行前各校验一次，不满足即返回 capability_required 并保留消息。', {
      teamId, to: text, text,
      expectsReply: { type: 'boolean' },
      replyTo: { type: 'string', minLength: 1, maxLength: 100 },
      ...dispatchRequirementProperties,
    }, ['teamId', 'to', 'text']],
    ['team_note', '向成员留下不唤醒的留言；留言只随成员下一轮正式输入交付，不进入主控收件箱。', { teamId, to: text, text }, ['teamId', 'to', 'text']],
    ['team_tasks_set', '整体更新当前主控在该团队的计划步骤。', {
      teamId,
      tasks: { type: 'array', minItems: 0, maxItems: 20 },
    }, ['teamId', 'tasks']],
    ['team_stop_member', '停止受控团队中某成员当前回合。', { teamId, member: text }, ['teamId', 'member']],
    ['team_member_model', '按宿主实时模型目录调整普通成员的模型与思考强度；无效模型不做默认替换。', {
      teamId,
      member: text,
      model: text,
      modelProvider: { type: 'string', minLength: 1, maxLength: 200 },
      reasoningEffort: { type: 'string', minLength: 1, maxLength: 100 },
    }, ['teamId', 'member', 'model', 'reasoningEffort']],
    ['control_decisions', '列出当前团队仍待用户决定、需要外部主控转述的请求。', {
      teamId,
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, ['teamId']],
    ['team_decision_answer', '把用户决定以 user-origin 消息送回原成员并唤醒。', {
      teamId,
      requestId: text,
      answer: { type: 'string', minLength: 1, maxLength: 16000 },
    }, ['teamId', 'requestId', 'answer']],
    ['team_archive', '归档受控团队；外部主控不能永久删除团队。', { teamId }, ['teamId']],
  ];
}

export function toolsForControlCapabilities(capabilities) {
  const definitions = controlToolDefinitions();
  const canElicit = capabilities == null
    || supportsControlCapability(capabilities, CONTROL_CAPABILITIES.userElicitation);
  const canWake = capabilities == null
    || supportsControlCapability(capabilities, CONTROL_CAPABILITIES.sessionWake);
  return definitions.filter(([name]) => (
    (canElicit || !['control_decisions', 'team_decision_answer'].includes(name))
    && (canWake || name !== 'control_wake_test')
  )).map(([name, description, properties, required]) => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  }));
}

export function protocolState(value) {
  const parsed = Number(value);
  const clientVersion = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  return {
    clientVersion,
    serverVersion: CONTROL_PROTOCOL_VERSION,
    compatible: clientVersion === CONTROL_PROTOCOL_VERSION,
    readOnly: clientVersion !== CONTROL_PROTOCOL_VERSION,
  };
}
