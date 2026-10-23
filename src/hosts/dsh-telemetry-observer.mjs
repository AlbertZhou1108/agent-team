export const inject = ['sessionProjections', 'llm'];

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const allowedSessionEvents = new Set(['assistant/message', 'assistant/attempt', 'turn/start', 'turn/end', 'step/start', 'step/end']);
const allowedProjections = new Set(['tokenUsage', 'contextPressure']);

export function apply(ctx) {
  ctx.on('session/event', (_session, event) => {
    if (!allowedSessionEvents.has(event.type)) return;
    const data = event.data ?? {};
    emit({
      type: 'framework.telemetry.event',
      event: event.type,
      at: event.time,
      turn: data.turn,
      step: data.step,
      usage: data.usage,
      reason: data.reason?.kind,
    });
  });
  ctx.sessionProjections.onChanged((_session, key, value, seq) => {
    if (!allowedProjections.has(key)) return;
    emit({ type: 'framework.telemetry.projection', key, value, seq });
  });
}
