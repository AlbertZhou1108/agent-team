import { defineStore } from 'pinia';
import { api, ApiError } from '@/shared/api/client';
import type { MessageRow, TeamDirectiveReceipt } from '@/shared/api/raw-types';

type Attempt = { text: string; operationId: string; controllerId: string };
type Entry = { draft: string; sending: boolean; error: string; attempt?: Attempt; receipt?: TeamDirectiveReceipt };
const storageKey = 'agent-team:directive-drafts';
function load(): Record<string, Entry> {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return Object.fromEntries(Object.entries(data).flatMap(([id, value]) => {
      const v = value as Entry;
      if (!v || typeof v.draft !== 'string') return [];
      const a = v.attempt;
      return [[id, { draft: v.draft, sending: false, error: '',
        attempt: a && typeof a.text === 'string' && typeof a.operationId === 'string' && typeof a.controllerId === 'string' ? a : undefined }]];
    }));
  } catch { return {}; }
}
export const useTeamDirectiveStore = defineStore('team-directives', {
  state: () => ({ entries: load(), acceptedMessages: {} as Record<string, MessageRow[]> }),
  actions: {
    entry(groupId: string): Entry {
      return this.entries[groupId] ??= { draft: '', sending: false, error: '' };
    },
    persist() {
      try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(Object.entries(this.entries)
        .map(([id, { draft, attempt }]) => [id, { draft, attempt }])))); } catch { /* In-memory draft remains available. */ }
    },
    setDraft(groupId: string, text: string) {
      this.entry(groupId).draft = text;
      this.persist();
    },
    async send(groupId: string, controllerId: string) {
      const entry = this.entry(groupId);
      const text = entry.draft.trim();
      if (entry.sending || !text || !controllerId) return;
      // An ambiguous network failure must retry the original request and recipient.
      if (entry.attempt?.text !== text) entry.attempt = undefined;
      const attempt = entry.attempt ?? { text, controllerId, operationId: crypto.randomUUID() };
      entry.attempt = attempt;
      entry.sending = true;
      entry.error = '';
      this.persist();
      try {
        const receipt = await api.sendTeamDirective(groupId, attempt);
        entry.receipt = receipt;
        const rows = this.acceptedMessages[groupId] ?? [];
        this.acceptedMessages[groupId] = [...rows.filter(row => row.id !== receipt.messageId), {
          id: receipt.messageId, seq: receipt.seq, group_id: groupId,
          sender: 'user', recipient: receipt.recipient, kind: 'send',
          text: attempt.text, reply_to: null, created: receipt.created,
        }].slice(-50) as MessageRow[];
        entry.attempt = undefined;
        if (entry.draft.trim() === text) entry.draft = '';
        this.persist();
        return receipt;
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) entry.attempt = undefined;
        this.persist();
      } finally { entry.sending = false; }
    },
  },
});
