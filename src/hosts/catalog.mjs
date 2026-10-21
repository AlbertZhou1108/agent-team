const text = (value, fallback = null) => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim();
};

function efforts(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  return values.flatMap(value => {
    const id = text(typeof value === 'string' ? value : value?.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      label: text(value?.label ?? value?.name, id),
      ...(text(value?.description) ? { description: text(value.description) } : {}),
    }];
  });
}

export function modelCatalog({ host, source, models = [], defaultModel = null, reasoningEfforts = [] }) {
  if (!text(host) || !text(source)) throw new Error('模型目录缺少宿主或来源');
  const seen = new Set();
  const normalized = models.map(model => {
    const id = text(model?.id);
    if (!id) throw new Error('模型目录包含空模型编号');
    const key = text(model.key, id);
    if (seen.has(key)) throw new Error(`模型目录包含重复模型: ${key}`);
    seen.add(key);
    const supported = efforts(model.reasoningEfforts);
    const defaultEffort = text(model.defaultReasoningEffort);
    if (defaultEffort && supported.length && !supported.some(item => item.id === defaultEffort)) {
      throw new Error(`模型 ${key} 的默认思考强度不在支持列表中`);
    }
    return {
      key,
      id,
      label: text(model.label, id),
      ...(text(model.provider) ? { provider: text(model.provider) } : {}),
      ...(text(model.description) ? { description: text(model.description) } : {}),
      ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities.filter(value => text(value)).map(value => text(value)) } : {}),
      ...(Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
      reasoningEfforts: supported,
      ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
      isDefault: model.isDefault === true,
    };
  });
  if (defaultModel != null && !models.some(model => text(model?.key, text(model?.id)) === defaultModel)) {
    throw new Error(`默认模型不在模型目录中: ${defaultModel}`);
  }
  return {
    version: 1,
    host,
    source,
    defaultModel,
    reasoningEfforts: efforts(reasoningEfforts),
    models: normalized,
  };
}
