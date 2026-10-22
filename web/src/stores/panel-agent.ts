import { defineStore } from 'pinia';
import { api } from '@/shared/api/client';
import type { PanelMessage } from '@/shared/api/raw-types';

const storageKey = 'agent-team:panel-agent';

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return {
      activeTeamId: typeof saved.activeTeamId === 'string' ? saved.activeTeamId : '',
      lastReadSeq: Number.isInteger(saved.lastReadSeq) ? saved.lastReadSeq : null,
    };
  } catch {
    return { activeTeamId: '', lastReadSeq: null };
  }
}

export function countUnreadPanelMessages(messages: PanelMessage[], lastReadSeq: number | null) {
  if (lastReadSeq == null) return 0;
  return messages.filter(message => message.role !== 'user' && message.seq > lastReadSeq).length;
}

export const usePanelAgentStore = defineStore('panel-agent', {
  state: () => ({
    ...loadState(),
    draft: '',
    submitting: false,
    sendError: '',
  }),
  actions: {
    persist() {
      localStorage.setItem(storageKey, JSON.stringify({
        activeTeamId: this.activeTeamId,
        lastReadSeq: this.lastReadSeq,
      }));
    },
    setActiveTeamId(teamId: string) {
      if (this.activeTeamId === teamId) return;
      this.activeTeamId = teamId;
      this.persist();
    },
    setDraft(value: string) {
      this.draft = value;
      if (this.sendError) this.sendError = '';
    },
    markPanelRead(seq: number) {
      if (this.lastReadSeq != null && seq <= this.lastReadSeq) return;
      this.lastReadSeq = seq;
      this.persist();
    },
    clearSendError() {
      this.sendError = '';
    },
    async sendMessage(text: string, activeTeamId?: string | null) {
      const value = text.trim();
      if (!value || this.submitting) return null;
      this.draft = '';
      this.submitting = true;
      this.sendError = '';
      try {
        return await api.panelMessage(value, activeTeamId ?? null);
      } catch (error) {
        if (!this.draft.trim()) this.draft = value;
        this.sendError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.submitting = false;
      }
    },
  },
});
