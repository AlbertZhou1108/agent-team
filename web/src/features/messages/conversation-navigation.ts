import type { LocationQuery } from 'vue-router';

export function teamConversationAfterSend(query: LocationQuery): LocationQuery {
  const next = { ...query };
  delete next.session;
  delete next.pair;
  delete next.interaction;
  delete next.message;
  return next;
}

/** An interaction's source endpoint can be a member/manager pair; its card belongs to the team feed. */
export function teamConversationSession(query: LocationQuery): string {
  if (typeof query.interaction === 'string' && query.interaction) return '';
  return typeof query.session === 'string' ? query.session : '';
}
