const output = value => {
  process.stdout.write(`AGENT_TEAM_DSH_MODEL_CATALOG ${JSON.stringify(value)}\n`, () => {
    // Exiting inside the write callback triggers a Windows/libuv closing-handle
    // assertion in DSH. Defer teardown; the parent still bounds the probe lifetime.
    setTimeout(() => process.exit(0), 50);
  });
};

export const inject = ['llm', 'agentDefaultModel'];

export function apply(ctx) {
  let started = false;
  const inspect = async () => {
    if (started || ctx.llm.listProviders().length === 0) return;
    started = true;
    clearTimeout(timeout);
    try {
      const defaultModel = ctx.agentDefaultModel.currentSelection();
      const providers = [];
      const failures = [];
      for (const provider of ctx.llm.listProviders()) {
        try {
          const models = [];
          for (const model of await ctx.llm.listModels(provider.id)) {
            const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
            models.push({
              key: `${provider.id}/${info.id}`,
              id: info.id,
              label: info.name,
              provider: provider.id,
              description: info.description,
              inputModalities: info.inputModalities,
              contextWindow: info.context?.contextWindow,
              reasoningEfforts: info.reasoning?.efforts?.map(effort => ({
                id: effort.id,
                label: effort.name,
                description: effort.description,
              })),
              defaultReasoningEffort: info.reasoning?.defaultEffort,
              isDefault: defaultModel.provider === provider.id && defaultModel.model === info.id,
            });
          }
          providers.push({ id: provider.id, label: provider.name, models });
        } catch (error) {
          failures.push({ provider: provider.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      output({
        ok: providers.some(provider => provider.models.length > 0),
        defaultModel: `${defaultModel.provider}/${defaultModel.model}`,
        providers,
        failures,
      });
    } catch (error) {
      output({ ok: false, defaultModel: null, providers: [], failures: [{ provider: null, error: error instanceof Error ? error.message : String(error) }] });
    }
  };
  const timeout = setTimeout(() => {
    if (!started) output({ ok: false, defaultModel: null, providers: [], failures: [{ provider: null, error: 'DSH LLM provider 未在限定时间内就绪' }] });
  }, 5000);
  ctx.on('llm/adapters-updated', () => setTimeout(inspect, 50));
  setTimeout(inspect, 1000);
}
