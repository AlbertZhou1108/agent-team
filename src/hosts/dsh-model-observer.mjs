export const inject = ['agents', 'llm'];

export function apply(ctx) {
  ctx.on('agent/request', async (_payload, next) => {
    const request = await next();
    let reasoningEffort = request.reasoningEffort ?? null;
    if (!reasoningEffort && request.provider && request.model) {
      try {
        const info = await ctx.llm.resolveModelInfo(request.provider, request.model);
        reasoningEffort = info.reasoning?.defaultEffort ?? null;
      } catch {
        // Catalog defaults are advisory; a missing lookup must not alter the request.
      }
    }
    process.stdout.write(`${JSON.stringify({
      type: 'framework.model.selection',
      provider: request.provider ?? null,
      model: request.model ?? null,
      reasoningEffort,
    })}\n`);
    return request;
  });
}
