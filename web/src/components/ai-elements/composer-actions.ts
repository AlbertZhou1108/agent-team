type ComposerState = { draft: string; sending: boolean; disabled: boolean };
export function createComposerActions(state: () => ComposerState, send: () => void) {
  function submit() {
    const current = state();
    if (current.draft.trim() && !current.sending && !current.disabled) send();
  }
  function onKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  }
  return { submit, onKeydown };
}
