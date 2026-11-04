// 工具参数通用校验器:成员工具与 Panel 工具共用同一套递归规则,
// 规则是 JSON Schema 的窄子集(type/enum/const/长度/区间/minItems/maxItems/
// items/properties/required/additionalProperties),原始数组额外要求去重。

export function validateToolValue(rule, value, path) {
  if (!rule) return;
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  if (rule.type) {
    const valid = types.some(type => {
      if (type === 'null') return value === null;
      if (type === 'array') return Array.isArray(value);
      if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
      if (type === 'integer') return Number.isInteger(value);
      return typeof value === type;
    });
    if (!valid) throw new Error(`${path}类型无效`);
  }
  if (rule.enum && !rule.enum.includes(value)) throw new Error(`${path}必须是以下值之一: ${rule.enum.join(', ')}`);
  if (Object.hasOwn(rule, 'const') && value !== rule.const) throw new Error(`${path}必须为${rule.const}`);
  if (typeof value === 'string') {
    if (rule.minLength !== undefined && value.trim().length < rule.minLength) throw new Error(`${path}需要非空文本`);
    if (rule.maxLength !== undefined && value.length > rule.maxLength) throw new Error(`${path}文本过长`);
  }
  if (typeof value === 'number') {
    if (rule.minimum !== undefined && value < rule.minimum) throw new Error(`${path}不能小于${rule.minimum}`);
    if (rule.maximum !== undefined && value > rule.maximum) throw new Error(`${path}不能大于${rule.maximum}`);
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) throw new Error(`${path}至少需要${rule.minItems}项`);
    if (rule.maxItems !== undefined && value.length > rule.maxItems) throw new Error(`${path}最多允许${rule.maxItems}项`);
    // 原始类型数组视为集合:重复项只会造成歧义(如 ask 的 options)。
    const itemIsObject = rule.items && (rule.items.type === 'object' || rule.items.properties);
    if (!itemIsObject && new Set(value).size !== value.length) throw new Error(`${path}存在重复项`);
    if (rule.items) value.forEach((item, index) => validateToolValue(rule.items, item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = rule.properties ?? {};
    for (const key of rule.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}为必填项`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateToolValue(properties[key], item, `${path}.${key}`);
      else if (rule.additionalProperties === false) throw new Error(`${path}不允许字段: ${key}`);
      else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') {
        validateToolValue(rule.additionalProperties, item, `${path}.${key}`);
      }
    }
  }
}
