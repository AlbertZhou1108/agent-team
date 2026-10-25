/** Keep event order while applying a stream burst in one render frame. */
export function frameBatch<T>(apply: (event: T) => void, schedule: (run: () => void) => number, cancel: (id: number) => void) {
  let pending: T[] = [];
  let frame: number | undefined;
  function flush() {
    if (frame !== undefined) cancel(frame);
    frame = undefined;
    const events = pending;
    pending = [];
    for (const event of events) apply(event);
  }
  return {
    push(event: T) {
      pending.push(event);
      if (frame === undefined) frame = schedule(flush);
    },
    flush,
    dispose() {
      if (frame !== undefined) cancel(frame);
      frame = undefined;
      pending = [];
    },
  };
}
