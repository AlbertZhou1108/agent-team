import { describe, expect, it } from 'vitest';
import { buildTaskPanelModel, countTaskStates } from '@/features/groups/task-panel-model';
import type { AgentTasksView, Member, PanelAgent } from '@/shared/api/raw-types';
import { buildTeamSummary, policyLabel } from '@/features/groups/team-summary';

describe('task-panel-model', () => {
  const members = [
    { id: 'm1', group_id: 'g', name: '甲', host: 'h', role: 'lead', removed: null },
    { id: 'm2', group_id: 'g', name: '乙', host: 'h', role: 'member', removed: null },
  ] as Member[];
  const panelAgent = { id: 'pa', name: '主控' } as PanelAgent;

  const view: AgentTasksView = {
    currentPlan: {
      plan_id: 'plan-1',
      group_id: 'g',
      owner_id: 'pa',
      owner_kind: 'panel_agent',
      revision: 1,
      updated: '2026-11-08T10:00:00Z',
      steps: [
        { id: 'step-1', text: '第一步', state: 'doing' },
        { id: 'step-2', text: '第二步', state: 'done' },
      ],
    },
    historicalPlans: [{
      plan_id: 'plan-0',
      group_id: 'g',
      owner_id: 'm1',
      owner_kind: 'member',
      revision: 0,
      frozen_at: '2026-11-07T10:00:00Z',
      steps: [{ id: 'old-1', text: '旧步骤', state: 'doing' }],
    }],
    memberTasks: [
      {
        owner_id: 'm1',
        group_id: 'g',
        owner_kind: 'member',
        updated: '2026-11-08T10:00:00Z',
        tasks: [
          { text: '执行一', state: 'doing', parent: { planId: 'plan-1', stepId: 'step-1' } },
          { text: '零散任务', state: 'done' },
          { text: '旧任务', state: 'doing', parent: { planId: 'plan-0', stepId: 'old-1' } },
        ],
      },
      {
        owner_id: 'm2',
        group_id: 'g',
        owner_kind: 'member',
        updated: '2026-11-08T10:00:00Z',
        tasks: [
          { text: '执行二', state: 'doing', parent: { planId: 'plan-1', stepId: 'step-1' } },
          { text: '孤儿', state: 'doing', parent: { planId: 'plan-9', stepId: 'gone' } },
        ],
      },
    ],
    cancelledSteps: [],
  };

  describe('task panel model', () => {
    it('nests linked tasks under steps and keeps unlinked or orphaned tasks in member groups', () => {
      const model = buildTaskPanelModel({ view, members, panelAgent });
      expect(model.current?.steps.map(step => step.number)).toEqual([1, 2]);
      expect(model.current?.steps[0].children.map(child => child.ownerName)).toEqual(['甲', '乙']);
      expect(model.current?.steps[0].children.map(child => child.number)).toEqual(['1.1', '1.2']);
      expect(model.historical[0].steps[0].children.map(child => child.task.text)).toEqual(['旧任务']);

      const byOwner = Object.fromEntries(model.members.map(group => [group.ownerId, group.tasks]));
      expect(byOwner.m1.map(item => item.task.text)).toEqual(['零散任务']);
      expect(byOwner.m2.map(item => [item.task.text, item.orphan])).toEqual([['孤儿', true]]);
      expect(model.counts).toEqual({ doing: 5, finished: 2 });
      expect(model.cancelled).toEqual([]);
      expect(model.empty).toBe(false);
    });

    it('reports an empty panel and zero counts for an empty projection', () => {
      const empty: AgentTasksView = { currentPlan: null, historicalPlans: [], memberTasks: [], cancelledSteps: [] };
      expect(buildTaskPanelModel({ view: empty, members, panelAgent }).empty).toBe(true);
      expect(countTaskStates(empty)).toEqual({ doing: 0, finished: 0 });
    });

    it('resolves an external controller owner name from actors', () => {
      const externalView: AgentTasksView = {
        currentPlan: {
          plan_id: 'plan-ext',
          group_id: 'g',
          owner_id: 'principal-1',
          owner_kind: 'external_agent',
          revision: 1,
          steps: [{ id: 'ext-step', text: '外部计划', state: 'doing' }],
        },
        historicalPlans: [],
        memberTasks: [],
        cancelledSteps: [],
      };
      const model = buildTaskPanelModel({
        view: externalView,
        members,
        panelAgent: null,
        actors: [{ id: 'principal-1', name: 'Codex 主控' }],
      });
      expect(model.current?.ownerName).toBe('Codex 主控');
    });
  });
});

describe('team-summary', () => {
  const draft = {
    name: ' 报价核对 ',
    worker: ' 协作助手 ',
    policy: 'read-only',
    workspace: ' /tmp/quote ',
    text: ' 核对三份报价 ',
  };

  describe('buildTeamSummary', () => {
    it('列出主 Agent 与协作助手,并去掉首尾空白', () => {
      const summary = buildTeamSummary(draft);
      expect(summary.name).toBe('报价核对');
      expect(summary.members).toEqual(['主 Agent', '协作助手']);
      expect(summary.workspace).toBe('/tmp/quote');
      expect(summary.request).toBe('核对三份报价');
    });

    it('协作助手留空时只列主 Agent', () => {
      expect(buildTeamSummary({ ...draft, worker: '   ' }).members).toEqual(['主 Agent']);
    });

    it('把文件访问范围翻译成用户能读的文字', () => {
      expect(buildTeamSummary(draft).policy).toBe('只读');
      expect(policyLabel('communication')).toBe('仅沟通');
      expect(policyLabel('workspace-write')).toBe('允许修改工作文件夹');
      expect(policyLabel('unknown-mode')).toBe('unknown-mode');
    });
  });
});
