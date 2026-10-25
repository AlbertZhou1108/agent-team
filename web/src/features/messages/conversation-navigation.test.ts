import { describe, expect, it } from 'vitest';
import { teamConversationAfterSend } from './conversation-navigation';

describe('sending from a linked interaction conversation', () => {
  it('leaves the old history anchor and session before displaying the new directive', () => {
    const query = { session: 'member-user', interaction: 'old-card', pair: 'member:user', panel: 'details' };
    expect(teamConversationAfterSend(query)).toEqual({ panel: 'details' });
    expect(query.interaction).toBe('old-card');
  });
});
