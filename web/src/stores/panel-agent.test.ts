import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePanelAgentStore } from './panel-agent';

const apiMocks = vi.hoisted(() => ({
  panelMessage: vi.fn(),
  uploadAttachment: vi.fn(),
  discardAttachment: vi.fn(),
}));

vi.mock('@/shared/api/client', () => ({
  api: {
    panelMessage: apiMocks.panelMessage,
    uploadAttachment: apiMocks.uploadAttachment,
    discardAttachment: apiMocks.discardAttachment,
  },
}));

let saved: string | null;

beforeEach(() => {
  saved = null;
  apiMocks.panelMessage.mockReset();
  apiMocks.uploadAttachment.mockReset();
  apiMocks.discardAttachment.mockReset();
  vi.stubGlobal('localStorage', {
    getItem: () => saved,
    setItem: (_key: string, value: string) => { saved = value; },
  });
  setActivePinia(createPinia());
});

describe('Panel Agent UI state', () => {
  it('persists the active team independently from the component lifecycle', () => {
    const store = usePanelAgentStore();
    store.setActiveTeamId('team-1');
    expect(store.activeTeamId).toBe('team-1');
    expect(JSON.parse(saved ?? '{}')).toMatchObject({ version: 3, activeTeamId: 'team-1' });
  });

  it('keeps draft and submission state while a message request is pending', async () => {
    let resolveRequest: ((value: { reply: unknown; result: string }) => void) | undefined;
    apiMocks.panelMessage.mockImplementation(() => new Promise(resolve => {
      resolveRequest = resolve;
    }));
    const store = usePanelAgentStore();
    store.draft = 'continue in background';
    const pending = store.sendMessage('continue in background', 'team-1');
    expect(store.draft).toBe('');
    expect(store.submitting).toBe(true);
    resolveRequest?.({ reply: null, result: 'done' });
    await pending;
    expect(store.submitting).toBe(false);
  });

});

describe('Panel attachment drafts and idempotent sending', () => {
  const settings = { maxFileBytes: 5 * 1024 * 1024, maxFilesPerMessage: 4, maxImagePixels: 20_000_000, updated: null };
  const textFile = (name = 'a.txt') => new File([new Blob(['hello'])], name, { type: 'text/plain' });

  it('uploads files to ready state and sends their ids with a stable clientMessageId', async () => {
    let resolveUpload: ((value: { id: string; name?: string; mediaType?: string; size?: number }) => void) | undefined;
    apiMocks.uploadAttachment.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    apiMocks.panelMessage.mockResolvedValue({ reply: null, result: 'done' });
    const store = usePanelAgentStore();

    expect(await store.addAttachmentFiles([textFile()], settings)).toBe('');
    expect(store.attachments).toHaveLength(1);
    expect(store.attachments[0].status).toBe('uploading');
    resolveUpload?.({ id: 'att-1', name: 'a.txt', mediaType: 'text/plain', size: 5 });
    await vi.waitFor(() => expect(store.attachments[0].status).toBe('ready'));

    store.draft = '看附件';
    await store.sendMessage('看附件', null);
    expect(apiMocks.panelMessage).toHaveBeenCalledWith('看附件', null, expect.objectContaining({
      attachmentIds: ['att-1'],
      clientMessageId: expect.any(String),
    }));
    // 成功后清空草稿与附件;下一条消息生成新 ID。
    expect(store.attachments).toHaveLength(0);
    expect(store.clientMessageId).toBeNull();
    const firstId = apiMocks.panelMessage.mock.calls[0][2].clientMessageId;
    apiMocks.panelMessage.mockClear();
    await store.sendMessage('第二条', null);
    expect(apiMocks.panelMessage.mock.calls[0][2].clientMessageId).not.toBe(firstId);
  });

  it('keeps the same clientMessageId across retries after a failure', async () => {
    apiMocks.uploadAttachment.mockResolvedValue({ id: 'att-1', name: 'a.txt', mediaType: 'text/plain', size: 5 });
    apiMocks.panelMessage.mockRejectedValueOnce(new Error('网络中断'));
    apiMocks.panelMessage.mockResolvedValueOnce({ reply: null, result: 'done' });
    const store = usePanelAgentStore();

    await store.addAttachmentFiles([textFile()], settings);
    await vi.waitFor(() => expect(store.attachments[0].status).toBe('ready'));

    store.draft = '重试消息';
    await expect(store.sendMessage('重试消息', null)).rejects.toThrow('网络中断');
    expect(store.clientMessageId).toBe(apiMocks.panelMessage.mock.calls[0][2].clientMessageId);
    // 失败保留草稿与附件,供同 ID 重试。
    expect(store.draft).toBe('重试消息');
    expect(store.attachments).toHaveLength(1);

    await store.sendMessage('重试消息', null);
    const firstCall = apiMocks.panelMessage.mock.calls[0][2];
    const secondCall = apiMocks.panelMessage.mock.calls[1][2];
    expect(secondCall.clientMessageId).toBe(firstCall.clientMessageId);
    expect(secondCall.attachmentIds).toEqual(firstCall.attachmentIds);
    expect(store.attachments).toHaveLength(0);
  });

  it('blocks sending while uploads are pending and rejects oversized or unsupported files', async () => {
    let resolveUpload: ((value: { id: string }) => void) | undefined;
    apiMocks.uploadAttachment.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    apiMocks.panelMessage.mockResolvedValue({ reply: null, result: 'done' });
    const store = usePanelAgentStore();

    expect(await store.addAttachmentFiles([textFile()], settings)).toBe('');
    expect(store.attachments[0].status).toBe('uploading');

    // 上传中发送被拒绝。
    await store.sendMessage('太急了', null);
    expect(apiMocks.panelMessage).not.toHaveBeenCalled();

    // 超限与不支持的类型被预检拒绝,不新增草稿。
    const big = new File([new Blob(['x'.repeat(16)])], 'big.txt', { type: 'text/plain' });
    Object.defineProperty(big, 'size', { value: settings.maxFileBytes + 1 });
    expect(await store.addAttachmentFiles([big], settings)).toMatch(/超过大小上限/);
    expect(await store.addAttachmentFiles([new File([new Blob(['x'])], 'v.pdf', { type: 'application/pdf' })], settings)).toMatch(/不支持的文件类型/);
    expect(store.attachments).toHaveLength(1);

    // 上传完成后可发送;附件-only 也允许。
    resolveUpload?.({ id: 'att-2' });
    await vi.waitFor(() => expect(store.attachments[0].status).toBe('ready'));
    await store.sendMessage('', null);
    expect(apiMocks.panelMessage).toHaveBeenCalledWith('', null, expect.objectContaining({ attachmentIds: ['att-2'] }));
  });

  it('removing a draft discards the uploaded copy from the server', async () => {
    apiMocks.uploadAttachment.mockResolvedValue({ id: 'att-1', name: 'a.txt', mediaType: 'text/plain', size: 5 });
    apiMocks.discardAttachment.mockResolvedValue(undefined);
    const store = usePanelAgentStore();

    await store.addAttachmentFiles([textFile()], settings);
    await vi.waitFor(() => expect(store.attachments[0].status).toBe('ready'));
    const localId = store.attachments[0].localId;

    await store.removeAttachment(localId);
    expect(store.attachments).toHaveLength(0);
    expect(apiMocks.discardAttachment).toHaveBeenCalledWith('att-1');
  });

  it('enforces the per-message attachment count from server settings', async () => {
    apiMocks.uploadAttachment.mockResolvedValue({ id: 'x', name: 'a.txt', mediaType: 'text/plain', size: 1 });
    const store = usePanelAgentStore();
    const tight = { ...settings, maxFilesPerMessage: 1 };
    expect(await store.addAttachmentFiles([textFile()], tight)).toBe('');
    expect(await store.addAttachmentFiles([textFile('b.txt')], tight)).toMatch(/最多 1 个附件/);
  });
});


it('accepts .env files during attachment preflight', () => {
  const store = usePanelAgentStore();
  const file = new File(['EXAMPLE=value'], '.env', { type: 'text/plain' });
  expect(store.validateAttachmentFile(file, undefined, 0)).toBe('');
});
