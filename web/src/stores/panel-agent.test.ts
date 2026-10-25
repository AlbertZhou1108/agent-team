import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  countUnreadPanelMessages,
  usePanelAgentStore,
} from './panel-agent';

const apiMocks = vi.hoisted(() => ({
  panelMessage: vi.fn(),
}));

vi.mock('@/shared/api/client', () => ({
  api: {
    panelMessage: apiMocks.panelMessage,
  },
}));

let saved: string | null;

beforeEach(() => {
  saved = null;
  apiMocks.panelMessage.mockReset();
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
    expect(JSON.parse(saved ?? '{}')).toMatchObject({ version: 2, activeTeamId: 'team-1', lastReadSeq: null, readByContext: {} });
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

  it('counts only new Agent messages after the read baseline', () => {
    const messages = [
      { seq: 10, role: 'assistant' },
      { seq: 11, role: 'user' },
      { seq: 12, role: 'system' },
      { seq: 13, role: 'assistant' },
    ] as never;
    expect(countUnreadPanelMessages(messages, null)).toBe(0);
    expect(countUnreadPanelMessages(messages, 9)).toBe(3);
    expect(countUnreadPanelMessages(messages, 11)).toBe(2);
  });
});

it('keeps unread messages in other contexts when opening one conversation, including after reload', () => {
  saved = JSON.stringify({ lastReadSeq: 10 });
  const store = usePanelAgentStore();
  const messages = [
    { seq: 11, role: 'assistant', active_team_id: 'a' },
    { seq: 12, role: 'system', active_team_id: 'b' },
    { seq: 13, role: 'assistant', active_team_id: null },
  ] as never;
  store.syncReadContexts(messages, 'a');
  expect(store.unreadForContext(messages, 'a')).toBe(0);
  expect(store.unreadForContext(messages, 'b')).toBe(1);
  expect(store.unreadForContext(messages, '')).toBe(1);
  setActivePinia(createPinia());
  const restored = usePanelAgentStore();
  expect(restored.unreadForContext(messages, 'b')).toBe(1);
  restored.syncReadContexts(messages, '');
  expect(restored.unreadForContext(messages, 'b')).toBe(1);
  expect(restored.unreadForContext(messages, '')).toBe(0);
});

it('baselines history once but counts messages in newly appearing contexts', () => {
  const store = usePanelAgentStore();
  store.syncReadContexts([{ seq: 10, role: 'assistant', active_team_id: null }] as never);
  const messages = [{ seq: 11, role: 'assistant', active_team_id: 'new-team' }] as never;
  store.syncReadContexts(messages);
  expect(store.unreadForContext(messages, 'new-team')).toBe(1);
});

it('marks all contexts read persistently and still counts later arrivals', () => {
  saved = JSON.stringify({ lastReadSeq: 1 });
  const store = usePanelAgentStore();
  const messages = [
    { seq: 2, role: 'assistant', active_team_id: null },
    { seq: 3, role: 'system', active_team_id: 'a' },
    { seq: 4, role: 'assistant', active_team_id: 'b' },
  ] as unknown as import('@/shared/api/raw-types').PanelMessage[];
  store.markAllPanelRead(messages);
  setActivePinia(createPinia());
  const restored = usePanelAgentStore();
  for (const context of ['', 'a', 'b']) expect(restored.unreadForContext(messages, context)).toBe(0);
  const updated = [...messages, { seq: 5, role: 'assistant', active_team_id: 'a' }] as never;
  expect(restored.unreadForContext(updated, 'a')).toBe(1);
});

it('keeps legacy tagged private history outside the global unread conversation', () => {
  saved = JSON.stringify({ lastReadSeq: 1 });
  const store = usePanelAgentStore();
  const messages = [
    { seq: 2, role: 'assistant', active_team_id: 'legacy-team' },
    { seq: 3, role: 'assistant', active_team_id: null },
  ] as unknown as import('@/shared/api/raw-types').PanelMessage[];
  expect(store.unreadForContext(messages, '')).toBe(1);
  store.syncReadContexts(messages, '');
  expect(store.unreadForContext(messages, '')).toBe(0);
  expect(store.unreadForContext(messages, 'legacy-team')).toBe(1);
});

it('counts new receipts once and deduplicates a source copy already read in its team', () => {
  const store = usePanelAgentStore();
  store.syncReceiptReads([], false);
  const requests = [{ receipts: [{ id: 'copy', text: 'reply', sourceMessageIds: ['team-message'], isSourceCopy: true }, { id: 'new-summary', text: 'new detail', sourceMessageIds: ['team-message'], isSourceCopy: false }] }] as unknown as import('@/shared/api/raw-types').TeamRequest[];
  store.syncReceiptReads(requests, false, ['team-message']);
  expect(store.unreadReceipts(requests)).toBe(1);
  store.syncReceiptReads(requests, true);
  expect(store.unreadReceipts(requests)).toBe(0);
  setActivePinia(createPinia());
  expect(usePanelAgentStore().unreadReceipts(requests)).toBe(0);
});
