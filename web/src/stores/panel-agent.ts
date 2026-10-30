import { defineStore } from 'pinia';
import { api } from '@/shared/api/client';
import type { UnreadMessage, UnreadReceipt } from '@/shared/api/raw-types';

const storageKey = 'agent-team:panel-agent';

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return {
      receiptInitialized: saved.version === 2 && saved.receiptInitialized === true,
      readReceiptIds: (Array.isArray(saved.readReceiptIds) ? saved.readReceiptIds.filter((id: unknown) => typeof id === 'string') : []) as string[],
      readTeamMessageIds: (Array.isArray(saved.readTeamMessageIds) ? saved.readTeamMessageIds.filter((id: unknown) => typeof id === 'string') : []) as string[],
      readByContext: (saved.readByContext && typeof saved.readByContext === 'object' ? saved.readByContext : {}) as Record<string, number>,
      activeTeamId: typeof saved.activeTeamId === 'string' ? saved.activeTeamId : '',
      lastReadSeq: Number.isInteger(saved.lastReadSeq) ? saved.lastReadSeq : null,
    };
  } catch {
    return { activeTeamId: '', lastReadSeq: null, readByContext: {} as Record<string, number>, receiptInitialized: false, readReceiptIds: [] as string[], readTeamMessageIds: [] as string[] };
  }
}

export function countUnreadPanelMessages(messages: UnreadMessage[], lastReadSeq: number | null) {
  if (lastReadSeq == null) return 0;
  return messages.filter(message => message.role !== 'user' && message.seq > lastReadSeq).length;
}

export const usePanelAgentStore = defineStore('panel-agent', {
  state: () => ({
    ...loadState(),
    historyVisible: false,
    draft: '',
    submitting: false,
    sendError: '',
  }),
  actions: {
    persist() {
      localStorage.setItem(storageKey, JSON.stringify({
        version: 2,
        receiptInitialized: this.receiptInitialized,
        readReceiptIds: this.readReceiptIds,
        readTeamMessageIds: this.readTeamMessageIds,
        readByContext: this.readByContext,
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
    unreadReceipts(requests: Array<{ receipts: UnreadReceipt[] }>) {
      return requests.flatMap(request => request.receipts).filter(receipt => !this.readReceiptIds.includes(receipt.id)).length;
    },
    syncReceiptReads(requests: Array<{ receipts: UnreadReceipt[] }>, onGlobal: boolean, visibleSourceIds: string[] = []) {
      const knownSources = new Set([...this.readTeamMessageIds, ...visibleSourceIds]);
      this.readTeamMessageIds = [...knownSources].slice(-5000);
      const read = new Set(this.readReceiptIds);
      for (const receipt of requests.flatMap(request => request.receipts)) {
        if (!this.receiptInitialized || onGlobal || (receipt.isSourceCopy && receipt.sourceMessageIds.every(id => knownSources.has(id)))) read.add(receipt.id);
      }
      this.receiptInitialized = true;
      this.readReceiptIds = [...read];
      this.persist();
    },
    unreadForContext(messages: UnreadMessage[], teamId: string) {
      const baseline = this.readByContext[teamId || '__global__'] ?? this.lastReadSeq;
      return countUnreadPanelMessages(messages.filter(message => (message.active_team_id || '') === teamId), baseline);
    },
    syncReadContexts(messages: UnreadMessage[], visibleContext?: string) {
      if (!messages.length) return;
      if (this.lastReadSeq == null) this.lastReadSeq = Math.max(...messages.map(message => message.seq));
      for (const message of messages) {
        const key = message.active_team_id || '__global__';
        if (!Number.isInteger(this.readByContext[key])) {
          this.readByContext[key] = this.lastReadSeq ?? Math.max(0, ...messages.filter(row => row.active_team_id === message.active_team_id).map(row => row.seq));
        }
        if (visibleContext !== undefined && (message.active_team_id || '') === visibleContext) {
          this.readByContext[key] = Math.max(this.readByContext[key]!, message.seq);
        }
      }
      this.persist();
    },
    markAllPanelRead(messages: UnreadMessage[]) {
      for (const message of messages) {
        const key = message.active_team_id || '__global__';
        this.readByContext[key] = Math.max(this.readByContext[key] ?? 0, message.seq);
      }
      this.persist();
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
