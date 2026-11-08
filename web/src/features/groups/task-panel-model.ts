import type { AgentPlanStep, AgentTask, AgentTaskEntry, AgentTasksView, Member, PanelAgent } from '@/shared/api/raw-types';
import { identityColor } from '@/features/messages/identity';

export interface TaskPanelChild {
  key: string;
  number: string;
  ownerName: string;
  color: string;
  task: AgentTask;
}

export interface TaskPanelStep {
  key: string;
  number: number;
  step: AgentPlanStep;
  children: TaskPanelChild[];
}

export interface TaskPanelPlan {
  planId: string;
  ownerName: string;
  color: string;
  timeLabel: string;
  steps: TaskPanelStep[];
}

export interface TaskPanelMemberTask {
  key: string;
  task: AgentTask;
  orphan: boolean;
}

export interface TaskPanelMemberGroup {
  ownerId: string;
  name: string;
  color: string;
  tasks: TaskPanelMemberTask[];
}

export interface TaskPanelCancelled {
  key: string;
  text: string;
  affectedNames: string[];
}

export interface TaskPanelModel {
  current: TaskPanelPlan | null;
  historical: TaskPanelPlan[];
  members: TaskPanelMemberGroup[];
  cancelled: TaskPanelCancelled[];
  counts: { doing: number; finished: number };
  empty: boolean;
}

export function countTaskStates(view: AgentTasksView | null | undefined) {
  const tasks = [
    ...(view?.currentPlan?.steps ?? []),
    ...(view?.memberTasks ?? []).flatMap(entry => entry.tasks),
  ];
  return {
    doing: tasks.filter(task => task.state === 'doing').length,
    finished: tasks.filter(task => task.state !== 'doing').length,
  };
}

function ownerNameOf(
  ownerId: string,
  ownerKind: 'member' | 'panel_agent' | 'external_agent',
  members: Member[],
  panelAgent: PanelAgent | null,
  actors: Array<{ id: string; name: string }>,
) {
  const member = members.find(item => item.id === ownerId);
  if (member) return member.name;
  if (ownerKind === 'panel_agent' && panelAgent) return panelAgent.name;
  const actor = actors.find(item => item.id === ownerId);
  if (actor) return actor.name;
  return ownerId;
}

function ownerOrder(ownerId: string, members: Member[]) {
  const index = members.findIndex(item => item.id === ownerId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function timeLabel(value: string | undefined, withDate: boolean) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', withDate
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }).format(date);
}

interface LinkedTask {
  entry: AgentTaskEntry;
  task: AgentTask;
  entryIndex: number;
  taskIndex: number;
}

function collectLinked(view: AgentTasksView, members: Member[]) {
  const linked = new Map<string, LinkedTask[]>();
  view.memberTasks.forEach((entry, entryIndex) => {
    entry.tasks.forEach((task, taskIndex) => {
      if (!task.parent) return;
      const key = `${task.parent.planId}\u0000${task.parent.stepId}`;
      const list = linked.get(key) ?? [];
      list.push({ entry, task, entryIndex, taskIndex });
      linked.set(key, list);
    });
  });
  for (const list of linked.values()) {
    list.sort((left, right) => (
      ownerOrder(left.entry.owner_id, members) - ownerOrder(right.entry.owner_id, members)
      || left.entryIndex - right.entryIndex
      || left.taskIndex - right.taskIndex
    ));
  }
  return linked;
}

function buildPlan(
  plan: NonNullable<AgentTasksView['currentPlan']>,
  linked: Map<string, LinkedTask[]>,
  members: Member[],
  panelAgent: PanelAgent | null,
  actors: Array<{ id: string; name: string }>,
  withDate: boolean,
): TaskPanelPlan {
  const ownerName = ownerNameOf(plan.owner_id, plan.owner_kind, members, panelAgent, actors);
  return {
    planId: plan.plan_id,
    ownerName,
    color: identityColor(ownerName),
    timeLabel: timeLabel(plan.frozen_at ?? plan.updated, withDate),
    steps: plan.steps.map((step, index) => {
      const key = `${plan.plan_id}\u0000${step.id}`;
      const children = (linked.get(key) ?? []).map(({ entry, task }, childIndex) => {
        const name = ownerNameOf(entry.owner_id, entry.owner_kind, members, panelAgent, actors);
        return {
          key: `${entry.owner_id}:${childIndex}:${task.text}`,
          number: `${index + 1}.${childIndex + 1}`,
          ownerName: name,
          color: identityColor(name),
          task,
        };
      });
      return { key, number: index + 1, step, children };
    }),
  };
}

/**
 * 把三段投影整理成可直接渲染的模型。
 * 当前计划的步骤不参与“已归档”展示;挂在历史计划下的成员任务计入成员区之前的历史结构。
 */
export function buildTaskPanelModel({ view, members, panelAgent, actors = [] }: {
  view: AgentTasksView;
  members: Member[];
  panelAgent: PanelAgent | null;
  actors?: Array<{ id: string; name: string }>;
}): TaskPanelModel {
  const linked = collectLinked(view, members);
  const current = view.currentPlan
    ? buildPlan(view.currentPlan, linked, members, panelAgent, actors, false)
    : null;
  const historical = view.historicalPlans.map(plan => (
    buildPlan(plan, linked, members, panelAgent, actors, true)
  ));

  const known = new Set<string>();
  if (view.currentPlan) for (const step of view.currentPlan.steps) known.add(`${view.currentPlan.plan_id}\u0000${step.id}`);
  for (const plan of view.historicalPlans) for (const step of plan.steps) known.add(`${plan.plan_id}\u0000${step.id}`);

  const loose = new Map<string, TaskPanelMemberGroup>();
  for (const entry of view.memberTasks) {
    const name = ownerNameOf(entry.owner_id, entry.owner_kind, members, panelAgent, actors);
    const group = loose.get(entry.owner_id) ?? {
      ownerId: entry.owner_id,
      name,
      color: identityColor(name),
      tasks: [],
    };
    entry.tasks.forEach((task, index) => {
      const orphan = Boolean(task.parent && !known.has(`${task.parent.planId}\u0000${task.parent.stepId}`));
      if (task.parent && !orphan) return;
      group.tasks.push({ key: `${entry.owner_id}:${index}:${task.text}`, task, orphan });
    });
    if (group.tasks.length) loose.set(entry.owner_id, group);
  }
  const memberGroups = [...loose.values()].sort((left, right) => (
    ownerOrder(left.ownerId, members) - ownerOrder(right.ownerId, members)
  ));

  const counts = countTaskStates(view);
  const cancelled = (view.cancelledSteps ?? []).map(item => ({
    key: item.id,
    text: item.text,
    affectedNames: item.affected.map(person => (
      ownerNameOf(person.owner_id, person.owner_kind, members, panelAgent, actors)
    )),
  }));
  return {
    current,
    historical,
    members: memberGroups,
    cancelled,
    counts,
    empty: !current && !historical.length && !memberGroups.length && !cancelled.length,
  };
}
