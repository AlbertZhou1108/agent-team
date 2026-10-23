import { describe, expect, it, vi } from 'vitest';
import { createComposerActions } from './composer-actions';
describe('shared message composer actions', () => {
  it('keeps IME and Shift+Enter as text input and sends Enter once', () => {
    const send = vi.fn();
    const actions = createComposerActions(() => ({ draft: 'hello', sending: false, disabled: false }), send);
    const key = (extra = {}) => actions.onKeydown({ key: 'Enter', preventDefault: vi.fn(), ...extra } as unknown as KeyboardEvent);
    key({ isComposing: true }); key({ shiftKey: true }); expect(send).not.toHaveBeenCalled();
    key(); expect(send).toHaveBeenCalledTimes(1);
  });
  it('guards both form and keyboard submission while sending, disabled or empty', () => {
    const send = vi.fn(); const state = { draft: 'hello', sending: true, disabled: false };
    const actions = createComposerActions(() => state, send);
    actions.submit();
    state.sending = false; state.disabled = true;
    actions.onKeydown({ key: 'Enter', preventDefault() {} } as KeyboardEvent); actions.submit();
    state.disabled = false; state.draft = '  '; actions.submit();
    expect(send).not.toHaveBeenCalled();
  });
});
