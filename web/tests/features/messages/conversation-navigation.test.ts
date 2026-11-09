import { describe, expect, it } from 'vitest';
import { teamConversationAfterSend } from '@/features/messages/conversation-navigation';

describe('sending from a linked interaction conversation', () => {
  it('leaves the old history anchor and session before displaying the new directive', () => {
    const query = { session: 'member-user', interaction: 'old-card', pair: 'member:user', panel: 'details' };
    expect(teamConversationAfterSend(query)).toEqual({ panel: 'details' });
    expect(query.interaction).toBe('old-card');
  });
});

import { teamConversationSession } from '@/features/messages/conversation-navigation';
describe('interaction links use the team conversation',()=>{
  it('ignores the source session in old interaction URLs so the user-facing card is visible',()=>{
    expect(teamConversationSession({session:'member-to-manager',interaction:'confirmation'})).toBe('');
  });
  it('preserves explicit session navigation without an interaction anchor',()=>{
    expect(teamConversationSession({session:'member-to-manager'})).toBe('member-to-manager');
    expect(teamConversationSession({})).toBe('');
  });
});
