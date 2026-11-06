// settings 聚合:模型策略(global_model_policy)、自定义策略配置(model_policy_presets)、
// 主题包(theme_packs)与附件设置(attachment_settings)的存取边界。
// 业务模块只通过本模块读写这些表;策略/主题的语义校验仍留在 model-policy.mjs 与 Bus。
// 所有函数接收 store,不持有全局状态。
//
// 不变式:
// - global_model_policy 是单行(singleton=1),preset_id 只允许指向存在的自定义配置或内置哨兵;
// - model_policy_presets.name 唯一,且在用的配置不允许删除;
// - theme_packs.name 唯一;内置主题不进库,库里只存用户上传的包;
// - attachment_settings 是单行(singleton=1),空表读取默认值。

// --- 模型策略 ---------------------------------------------------------------

/** 当前生效的全局策略(单行)。 */
export function modelPolicy(store) {
  return store.get('SELECT mode,rules,preset_id,created,updated FROM global_model_policy WHERE singleton=1');
}

/** 生效策略当前引用的自定义配置 id(内置哨兵或没有引用时为 null)。 */
export function activePresetId(store) {
  return modelPolicy(store)?.preset_id ?? null;
}

export function updateModelPolicy(store, { mode, rules, presetId, updated }) {
  return store.run(
    'UPDATE global_model_policy SET mode=?,rules=?,preset_id=?,updated=? WHERE singleton=1',
    mode, rules, presetId, updated,
  );
}

// --- 自定义策略配置 ---------------------------------------------------------

export function presetById(store, id) {
  return store.get('SELECT * FROM model_policy_presets WHERE id=?', id) ?? null;
}

export function presetNameTaken(store, name) {
  return Boolean(store.get('SELECT 1 FROM model_policy_presets WHERE name=?', name));
}

/** 重命名冲突检查:同名但排除自己。 */
export function presetNameConflict(store, name, excludeId) {
  return Boolean(store.get('SELECT 1 FROM model_policy_presets WHERE name=? AND id<>?', name, excludeId));
}

export function listPresets(store) {
  return store.all('SELECT id,name,mode,rules,created,updated FROM model_policy_presets ORDER BY updated DESC');
}

export function insertPreset(store, { id, name, mode, rules, created, updated }) {
  return store.run(
    'INSERT INTO model_policy_presets(id,name,mode,rules,created,updated) VALUES(?,?,?,?,?,?)',
    id, name, mode, rules, created, updated,
  );
}

export function renamePreset(store, id, name, updated) {
  return store.run('UPDATE model_policy_presets SET name=?,updated=? WHERE id=?', name, updated, id);
}

export function updatePreset(store, id, { mode, rules, updated }) {
  return store.run('UPDATE model_policy_presets SET mode=?,rules=?,updated=? WHERE id=?', mode, rules, updated, id);
}

export function deletePreset(store, id) {
  return store.run('DELETE FROM model_policy_presets WHERE id=?', id);
}

// --- 主题包 -----------------------------------------------------------------

export function listThemePacks(store) {
  return store.all('SELECT id,name,light,dark,created,updated FROM theme_packs ORDER BY updated DESC');
}

export function themeNameTaken(store, name) {
  return Boolean(store.get('SELECT 1 FROM theme_packs WHERE name=?', name));
}

export function insertThemePack(store, { id, name, light, dark, created, updated }) {
  return store.run(
    'INSERT INTO theme_packs(id,name,light,dark,created,updated) VALUES(?,?,?,?,?,?)',
    id, name, light, dark, created, updated,
  );
}

export function themePackById(store, id) {
  return store.get('SELECT id,name,light,dark,created,updated FROM theme_packs WHERE id=?', id) ?? null;
}

export function deleteThemePack(store, id) {
  return store.run('DELETE FROM theme_packs WHERE id=?', id);
}

// --- 附件设置(单行;现有 Store 方法已封装默认值与校验) --------------------

export function attachmentSettings(store) {
  return store.attachmentSettings();
}

export function updateAttachmentSettings(store, value) {
  return store.updateAttachmentSettings(value);
}
