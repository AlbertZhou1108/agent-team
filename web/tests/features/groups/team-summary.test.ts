import { describe, expect, it } from 'vitest';
import { buildTeamSummary, policyLabel } from '@/features/groups/team-summary';

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
