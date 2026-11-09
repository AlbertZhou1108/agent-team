// 应用设置：模型策略预设、主题包与附件上传设置。
//
// 这些都是「用户配置」，与业务运行时无关：策略预设只是编辑辅助层，激活策略仍是
// global_model_policy 单行；主题包只存用户上传的包，内置主题在前端代码里。
// 单独成类后，校验规则（名称长度、token 结构、正在使用中不可删）集中在一处。

import { randomUUID } from 'node:crypto';
import { BUILTIN_PRESET_ID, normalizeModelPolicy } from '../model-policy.mjs';
import * as settingsAgg from '../aggregates/settings.mjs';

export class AppSettings {
  constructor(bus) {
    this.bus = bus;
  }

  modelPolicy() {
    return settingsAgg.modelPolicy(this.bus.store);
  }

  updateModelPolicy(value) {
    const policy = normalizeModelPolicy(value);
    // presetId 只由调用方显式给出：内容相同的多份配置无法靠文本区分。
    // 内置默认规则用固定哨兵值，让它也能被精确回指（否则保存后无法高亮）。
    let presetId = null;
    if (value?.presetId === BUILTIN_PRESET_ID) {
      presetId = BUILTIN_PRESET_ID;
    } else if (typeof value?.presetId === 'string' && value.presetId) {
      const preset = settingsAgg.presetById(this.bus.store, value.presetId);
      if (!preset) throw new Error('配置不存在');
      presetId = preset.id;
    }
    settingsAgg.updateModelPolicy(this.bus.store, {
      mode: policy.mode,
      rules: policy.rules,
      presetId,
      updated: new Date().toISOString(),
    });
    return this.modelPolicy();
  }

  // 自定义策略配置：编辑辅助层，不参与运行时；激活策略仍是 global_model_policy 单行。
  modelPolicyPresets() {
    return settingsAgg.listPresets(this.bus.store);
  }

  normalizePresetName(name) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value || value.length > 60) throw new Error('配置名称需要 1-60 字符');
    return value;
  }

  // 自定义配置只属于「用户配置」模式：智能策略的两个模板是代码内置的，不可自建。
  createPreset({ name, rules }) {
    const normalized = this.normalizePresetName(name);
    if (settingsAgg.presetNameTaken(this.bus.store, normalized)) throw new Error('配置名称已存在');
    const policy = normalizeModelPolicy({ mode: 'user', rules });
    const now = new Date().toISOString();
    settingsAgg.insertPreset(this.bus.store, {
      id: randomUUID(),
      name: normalized,
      mode: 'user',
      rules: policy.rules,
      created: now,
      updated: now,
    });
    return this.modelPolicyPresets().find(row => row.name === normalized);
  }

  renamePreset(id, name) {
    const normalized = this.normalizePresetName(name);
    const existing = settingsAgg.presetById(this.bus.store, id);
    if (!existing) throw new Error('配置不存在');
    const conflict = settingsAgg.presetNameConflict(this.bus.store, normalized, id);
    if (conflict) throw new Error('配置名称已存在');
    settingsAgg.renamePreset(this.bus.store, id, normalized, new Date().toISOString());
    return this.modelPolicyPresets().find(row => row.id === id);
  }

  savePreset(id, { mode, rules }) {
    const existing = settingsAgg.presetById(this.bus.store, id);
    if (!existing) throw new Error('配置不存在');
    const policy = normalizeModelPolicy({ mode, rules });
    settingsAgg.updatePreset(this.bus.store, id, { mode: policy.mode, rules: policy.rules, updated: new Date().toISOString() });
    return this.modelPolicyPresets().find(row => row.id === id);
  }

  deletePreset(id) {
    const existing = settingsAgg.presetById(this.bus.store, id);
    if (!existing) throw new Error('配置不存在');
    // 正在使用的配置不允许删除：先切到其他策略再删，避免生效策略失去来源或被静默改写。
    const activePresetId = settingsAgg.activePresetId(this.bus.store);
    if (activePresetId === id) throw new Error('该配置正在使用中，请先切换到其他配置再删除');
    settingsAgg.deletePreset(this.bus.store, id);
    return { deleted: id };
  }

  // 主题包：内置主题随应用发布、不进库（前端代码持有），这里只存用户上传的包。
  // 服务端只做结构级校验（可解析、长度、键数），颜色语义校验在前端导入时完成。
  themePacks() {
    return settingsAgg.listThemePacks(this.bus.store);
  }

  normalizeThemePackName(name) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value || value.length > 60) throw new Error('主题名称需要 1-60 字符');
    return value;
  }

  validateThemePackTokens(value, label) {
    if (typeof value !== 'string' || value.length > 16384) throw new Error(`${label}数据过大或缺失`);
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${label}不是有效 JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}格式不正确`);
    const keys = Object.keys(parsed);
    if (keys.length > 64) throw new Error(`${label}变量过多`);
    for (const key of keys) {
      const item = parsed[key];
      if (typeof item !== 'string' || item.length > 128) throw new Error(`${label}存在非法变量值`);
    }
  }

  createThemePack({ name, light, dark }) {
    const normalized = this.normalizeThemePackName(name);
    if (settingsAgg.themeNameTaken(this.bus.store, normalized)) throw new Error('主题名称已存在');
    this.validateThemePackTokens(light, '浅色');
    this.validateThemePackTokens(dark, '深色');
    const now = new Date().toISOString();
    const id = randomUUID();
    settingsAgg.insertThemePack(this.bus.store, { id, name: normalized, light, dark, created: now, updated: now });
    return settingsAgg.themePackById(this.bus.store, id);
  }

  deleteThemePack(id) {
    const existing = settingsAgg.themePackById(this.bus.store, id);
    if (!existing) throw new Error('主题不存在');
    // 使用中由各端偏好自行禁删（选中状态存在浏览器端，服务端无全局「当前主题」）；
    // 跨设备删除后，其他端解析不到该 id 时自动回落内置主题。
    settingsAgg.deleteThemePack(this.bus.store, id);
    return { deleted: id };
  }

  attachmentSettings() {
    return settingsAgg.attachmentSettings(this.bus.store);
  }

  updateAttachmentSettings(value) {
    return settingsAgg.updateAttachmentSettings(this.bus.store, value);
  }
}
