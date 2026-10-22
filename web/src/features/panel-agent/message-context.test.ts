import { describe, expect, it } from 'vitest';
import type { PanelMessage } from '@/shared/api/raw-types';
import { filterPanelMessagesForContext } from './message-context';

const messages = [
  { id: 'global-user', seq: 1, active_team_id: null },
  { id: 'team-a-user', seq: 2, active_team_id: 'team-a' },
  { id: 'team-b-user', seq: 3, active_team_id: 'team-b' },
  { id: 'team-a-reply', seq: 4, active_team_id: 'team-a' },
] as PanelMessage[];

describe('Panel Agent message context', () => {
  it('shows only global messages in the global context', () => {
    expect(filterPanelMessagesForContext(messages, '').map(message => message.id))
      .toEqual(['global-user']);
  });

  it('shows only messages bound to the selected team', () => {
    expect(filterPanelMessagesForContext(messages, 'team-a').map(message => message.id))
      .toEqual(['team-a-user', 'team-a-reply']);
    expect(filterPanelMessagesForContext(messages, 'team-b').map(message => message.id))
      .toEqual(['team-b-user']);
  });

  it('does not leak messages without the selected team context', () => {
    expect(filterPanelMessagesForContext(messages, 'missing-team')).toEqual([]);
  });
});
