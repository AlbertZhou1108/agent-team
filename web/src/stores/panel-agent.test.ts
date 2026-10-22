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
    expect(JSON.parse(saved ?? '{}')).toEqual({ activeTeamId: 'team-1', lastReadSeq: null });
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
