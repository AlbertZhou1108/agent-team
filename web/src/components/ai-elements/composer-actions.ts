type ComposerState = { draft: string; sending: boolean; disabled: boolean; hasAttachments?: boolean };
export function createComposerActions(state: () => ComposerState, send: () => void) {
  function submit() {
    const current = state();
    // 正文和附件任一非空即可发送;附件-only 是合法消息。
    if ((current.draft.trim() || current.hasAttachments) && !current.sending && !current.disabled) send();
  }
  function onKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  }
  return { submit, onKeydown };
}
