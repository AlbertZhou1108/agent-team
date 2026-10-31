import { defineStore } from 'pinia';
import { toast } from 'vue-sonner';
import { api } from '@/shared/api/client';
import type { AttachmentSettings, UnreadMessage, UnreadReceipt, UploadedAttachment } from '@/shared/api/raw-types';
import { classifyAttachmentName, formatAttachmentSize } from '@/shared/attachment-types';

/** 输入框附件草稿:内存态,不要求刷新恢复;上传失败保留条目等用户移除。 */
export type AttachmentDraft = {
  localId: string;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'failed';
  error?: string;
  attachment?: UploadedAttachment;
};

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
    attachments: [] as AttachmentDraft[],
    clientMessageId: null as string | null,
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
    // 客户端文件预检:服务端仍是最终校验方;拒绝时不修改已有草稿。
    validateAttachmentFile(file: File, settings: AttachmentSettings | undefined, currentCount: number) {
      if (file.size <= 0) return '文件内容为空';
      if (!classifyAttachmentName(file.name)) return '不支持的文件类型:支持常见文本文件与 PNG/JPEG 图片';
      if (settings && file.size > settings.maxFileBytes) {
        return `文件超过大小上限 ${formatAttachmentSize(settings.maxFileBytes)}`;
      }
      if (settings && currentCount >= settings.maxFilesPerMessage) {
        return `单条消息最多 ${settings.maxFilesPerMessage} 个附件`;
      }
      return '';
    },
    async addAttachmentFiles(files: File[], settings?: AttachmentSettings) {
      for (const file of files) {
        const invalid = this.validateAttachmentFile(file, settings, this.attachments.length);
        const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (invalid) {
          // 预检失败的文件不留草稿条目,错误通过返回值交给调用方提示。
          return invalid;
        }
        const draftItem: AttachmentDraft = { localId, name: file.name, size: file.size, status: 'uploading' };
        this.attachments.push(draftItem);
        void api.uploadAttachment(file)
          .then(uploaded => {
            const item = this.attachments.find(row => row.localId === localId);
            if (!item) return; // 上传期间被用户移除:直接丢弃副本。
            item.status = 'ready';
            item.attachment = uploaded;
          })
          .catch((cause: unknown) => {
            const item = this.attachments.find(row => row.localId === localId);
            if (!item) return;
            item.status = 'failed';
            item.error = cause instanceof Error ? cause.message : String(cause);
            // 错误原因走 toast 提示组件;附件条只保留"上传失败"状态标记。
            toast.error(`附件上传失败:${item.error}`);
          });
      }
      return '';
    },
    async removeAttachment(localId: string) {
      const item = this.attachments.find(row => row.localId === localId);
      if (!item) return;
      this.attachments = this.attachments.filter(row => row.localId !== localId);
      // 已上传的副本同步从服务端移除;失败不阻塞,未发送副本由定时清理兜底。
      if (item.attachment?.id) {
        try {
          await api.discardAttachment(item.attachment.id);
        } catch {
          // 服务端已不可删(如刚被发送)时忽略。
        }
      }
    },
    clearAttachments() {
      this.attachments = [];
    },
    async sendMessage(text: string, activeTeamId?: string | null) {
      const value = text.trim();
      if ((!value && !this.attachments.length) || this.submitting) return null;
      if (this.attachments.some(item => item.status !== 'ready')) return null;
      this.draft = '';
      this.submitting = true;
      this.sendError = '';
      // 结果未确认前 clientMessageId 保持不变:同一 ID 重试由服务端幂等回放,不会重复建消息。
      const clientMessageId = this.clientMessageId ?? crypto.randomUUID();
      const attachmentIds = this.attachments
        .map(item => item.attachment?.id)
        .filter((id): id is string => Boolean(id));
      try {
        const response = await api.panelMessage(value, activeTeamId ?? null, { clientMessageId, attachmentIds });
        // 服务端明确确认:本轮草稿与消息 ID 都收尾,下一条消息生成新 ID。
        this.clientMessageId = null;
        this.attachments = [];
        return response;
      } catch (error) {
        this.clientMessageId = clientMessageId;
        if (!this.draft.trim()) this.draft = value;
        this.sendError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.submitting = false;
      }
    },
  },
});
