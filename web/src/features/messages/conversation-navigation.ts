import type { LocationQuery } from 'vue-router';

export function teamConversationAfterSend(query: LocationQuery): LocationQuery {
  const next = { ...query };
  delete next.session;
  delete next.pair;
  delete next.interaction;
  delete next.message;
  return next;
}
