import type { PanelMessage } from '@/shared/api/raw-types';

export function filterPanelMessagesForContext(
  messages: PanelMessage[],
  activeTeamId: string,
): PanelMessage[] {
  const contextId = activeTeamId || null;
  return messages.filter(message => message.active_team_id === contextId);
}
