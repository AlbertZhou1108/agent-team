export interface TeamDraft {
  name: string;
  worker: string;
  policy: string;
  workspace: string;
  text: string;
}

export interface TeamSummary {
  name: string;
  members: string[];
  policy: string;
  workspace: string;
  request: string;
}

const POLICY_LABELS: Record<string, string> = {
  communication: '仅沟通',
  'read-only': '只读',
  'workspace-write': '允许修改工作文件夹',
};

export function policyLabel(policy: string): string {
  return POLICY_LABELS[policy] ?? policy;
}

/** 建群前的确认摘要:成员、文件访问范围、工作目录与需求必须让用户先看到。 */
export function buildTeamSummary(draft: TeamDraft): TeamSummary {
  return {
    name: draft.name.trim(),
    members: ['主 Agent', draft.worker.trim()].filter(Boolean),
    policy: policyLabel(draft.policy),
    workspace: draft.workspace.trim(),
    request: draft.text.trim(),
  };
}
