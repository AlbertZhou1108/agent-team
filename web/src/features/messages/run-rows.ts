import type { StreamPhase, StreamTool } from '@/shared/api/raw-types';
import type { StreamView } from './adapters';

/** 一次运行(一个回合)在状态卡里的一行。 */
export type RunRow = {
  key: string;
  name: string;
  phase: StreamPhase;
  tool: StreamTool | null;
  /** 该回合最早的流创建时间,用于计时;缺失时不显示时长。 */
  startedAt: string | null;
  reasoning: string;
  views: StreamView[];
};

const phaseLabels: Record<StreamPhase, string> = {
  accepted: '处理中',
  thinking: '思考中',
  writing: '输出中',
  tool: '调用工具',
};

export function runPhaseLabel(phase: StreamPhase) {
  return phaseLabels[phase];
}

/**
 * 阶段优先取服务端下发的 runPhase;旧服务端或工具草稿流没有该字段时,
 * 按已有内容回落到“有正文=输出中、有思考=思考中、否则处理中”。
 */
export function runPhaseOf(view: StreamView): StreamPhase {
  if (view.runPhase) return view.runPhase;
  if (view.message.text.trim()) return 'writing';
  if (view.reasoning?.trim()) return 'thinking';
  return 'accepted';
}

const toolActions: Record<string, (group?: string) => string> = {
  teams_list: () => '正在读取团队列表',
  team_snapshot: () => '正在读取团队概况',
  team_read: group => (group ? `正在读取「${group}」的团队消息` : '正在读取团队消息'),
  team_members: group => (group ? `正在读取「${group}」的成员` : '正在读取团队成员'),
  team_message_trace: () => '正在核对消息来源',
  team_turn_trace: () => '正在核对执行轨迹',
  model_catalog: () => '正在读取模型目录',
  team_create: () => '正在创建团队',
  request_team_takeover: group => (group ? `正在申请接管「${group}」` : '正在申请接管团队'),
  request_team_handback: group => (group ? `正在申请交还「${group}」` : '正在申请交还团队'),
  team_send: () => '正在向成员发送消息',
  team_note: () => '正在向成员留言',
  send: () => '正在发送消息',
  note: () => '正在留言',
  group_add: () => '正在添加成员',
  group_remove: () => '正在移除成员',
  group_member_model: () => '正在调整成员模型',
  group_tasks_set: () => '正在更新任务列表',
  ask: () => '正在发出互动卡',
  team_request_submit: () => '正在转交团队请求',
  team_requests: () => '正在读取团队请求',
  team_receipt_publish: () => '正在发布请求回执',
  panel_update_publish: () => '正在发布团队通知',
};

/** 工具名面向用户的说明;未知工具只说明正在执行,不暴露内部名称。 */
export function toolActionLabel(tool: StreamTool | null, groupNames: Record<string, string> = {}) {
  if (!tool) return '';
  const group = tool.groupId ? groupNames[tool.groupId] : undefined;
  return toolActions[tool.name]?.(group) ?? '正在执行操作';
}

/** 一个回合可能同时有多条流(正文流 + 工具草稿流),按回合聚合为一行。 */
export function buildRunRows(views: StreamView[]): RunRow[] {
  const groups = new Map<string, StreamView[]>();
  for (const view of views) {
    const key = view.turnId || view.message.id;
    const list = groups.get(key);
    if (list) list.push(view);
    else groups.set(key, [view]);
  }
  return [...groups].map(([key, list]) => {
    // 回合流(非工具草稿)携带阶段与思考;工具草稿只补充正文。
    const primary = list.find(view => !view.toolCallId) ?? list[0]!;
    const phase = runPhaseOf(primary);
    return {
      key,
      name: primary.message.senderName,
      phase,
      tool: phase === 'tool' ? primary.tool ?? null : null,
      startedAt: list
        .map(view => view.startedAt)
        .filter((value): value is string => Boolean(value))
        .sort()[0] ?? null,
      reasoning: list.reduce(
        (best, view) => ((view.reasoning?.length ?? 0) > best.length ? view.reasoning! : best),
        '',
      ),
      views: list,
    };
  });
}

/** 计时以服务端流创建时间为锚点,刷新或重连不会归零。 */
export function elapsedLabel(startedAt: string | null | undefined, now: number) {
  if (!startedAt) return '';
  const elapsed = now - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 1000) return '';
  return `${Math.floor(elapsed / 1000)} 秒`;
}
