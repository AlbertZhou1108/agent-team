import { describe, expect, it } from 'vitest';
import { isPreparationApprovable } from './preparation';
import type { PanelPreparation } from './types';

function preparation(overrides: Partial<PanelPreparation> = {}): PanelPreparation {
  return {
    id: 'preparation-1',
    spec: {
      name: 'team',
      workspace: '/tmp/team',
      panelAgentId: 'panel-agent',
      members: [{ name: 'worker', host: 'dsh' }],
    },
    contract: {
      goal: 'goal',
      scope: 'scope',
      boundary: 'boundary',
      confirmation: 'confirm',
      delivery: 'delivery',
      policy: 'communication',
      allowShell: false,
      criteria: [{ id: 'c1', text: 'criterion' }],
    },
    revision: 1,
    hash: 'hash',
    group_id: null,
    created: '2026-10-22T12:00:00.000Z',
    rolePlan: {
      roles: [{
        name: 'worker',
        model_provider: 'provider',
        model: 'model',
        reasoning_effort: 'low',
      }],
    },
    ...overrides,
  };
}

describe('Panel preparation approval', () => {
  it('hides preparations without a complete role plan', () => {
    expect(isPreparationApprovable(preparation({ rolePlan: null }))).toBe(false);
    expect(isPreparationApprovable(preparation({ rolePlan: { roles: [] } }))).toBe(false);
  });

  it('allows only pending preparations with a complete plan', () => {
    expect(isPreparationApprovable(preparation())).toBe(true);
    expect(isPreparationApprovable(preparation({ group_id: 'created' }))).toBe(false);
  });
});
