export const inject = ['sessionProjections', 'llm'];

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const allowedSessionEvents = new Set([
  'assistant/message',
  'assistant/attempt',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
]);
const allowedProjections = new Set(['tokenUsage', 'contextPressure']);

export function dshSessionEventFrame(event) {
  if (!allowedSessionEvents.has(event.type)) return null;
  const data = event.data ?? {};
  return {
      type: 'framework.telemetry.event',
      event: event.type,
      at: event.time,
      turn: data.turn,
      step: data.step,
      usage: data.usage,
      reason: data.reason?.kind,
  };
}

export async function* observeTextStream(stream, onFrame = emit, options = {}) {
  if (options.purpose !== undefined) {
    yield* stream;
    return;
  }
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' && chunk.text) {
      onFrame({
        type: 'framework.text.delta',
        text: chunk.text,
        index: chunk.index,
        provider: options.provider,
        model: options.model,
      });
    }
    if (chunk.type === 'tool-call-delta') {
      onFrame({
        type: 'framework.tool.delta',
        callId: chunk.id,
        name: chunk.name,
        index: chunk.index,
        argumentsDelta: chunk.argumentsDelta ?? '',
        provider: options.provider,
        model: options.model,
      });
    }
    yield chunk;
  }
}

export function apply(ctx) {
  ctx.on('session/event', (_session, event) => {
    const frame = dshSessionEventFrame(event);
    if (frame) emit(frame);
  });
  ctx.on('llm/stream', (options, next) => (
    observeTextStream(next(), emit, options)
  ), { global: true });
  ctx.sessionProjections.onChanged((_session, key, value, seq) => {
    if (!allowedProjections.has(key)) return;
    emit({ type: 'framework.telemetry.projection', key, value, seq });
  });
}
