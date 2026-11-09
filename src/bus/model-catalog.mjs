// 宿主模型目录：探测、缓存、去重，以及成员模型选择的校验与落地。
//
// 这段逻辑原本长在 Bus 上，32 行的缓存/超时/并发去重和设置域混在一起，
// 只能透过整条总线测。单独成类之后，探测行为可以脱离 Bus 单独验证。

import { memberModelSummary } from '../model-policy.mjs';
import * as teamsAgg from '../aggregates/teams.mjs';

const TTL_MS = 30000;
const PROBE_TIMEOUT_MS = 25000;

export class ModelCatalog {
  constructor(bus) {
    this.bus = bus;
    this.cache = null;
    this.catalogs = new Map();
    this.pending = new Map();
    this.controllers = new Map();
  }

  /** 探测模型目录；同一宿主的并发请求合并成一次，30 秒内复用结果。 */
  async list({ refresh = false, host: selectedHost } = {}) {
    if (selectedHost) this.bus.requireHost(selectedHost);
    const names = selectedHost ? [selectedHost] : [...this.bus.hosts.keys()];
    const cached = names.every(name => !refresh && this.catalogs.has(name) && Date.now() - this.catalogs.get(name).created < TTL_MS);
    const hosts = await Promise.all(names.map(async hostName => {
      const previous = this.catalogs.get(hostName);
      if (!refresh && previous && Date.now() - previous.created < TTL_MS) return previous.value;
      if (!this.pending.has(hostName)) {
        const pending = (async () => {
          const host = this.bus.hosts.get(hostName);
          let timer;
          const controller = new AbortController();
          this.controllers.set(hostName, controller);
          try {
            if (!host.listModels) throw new Error('宿主适配器未提供模型目录');
            const catalog = await Promise.race([
              Promise.resolve().then(() => host.listModels({ signal: controller.signal })),
              new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('模型目录探测超时')); }, PROBE_TIMEOUT_MS); }),
            ]);
            return { host: hostName, ok: true, catalog };
          } catch (error) { return { host: hostName, ok: false, error: error.message }; }
          finally { clearTimeout(timer); this.controllers.delete(hostName); }
        })().then(value => { this.catalogs.set(hostName, { created: Date.now(), value }); return value; })
          .finally(() => this.pending.delete(hostName));
        this.pending.set(hostName, pending);
      }
      return this.pending.get(hostName);
    }));
    const value = { version: 1, generatedAt: new Date().toISOString(), hosts };
    this.cache = { created: Date.now(), value: { ...value, hosts: [...this.catalogs.values()].map(entry => entry.value) } };
    return { ...value, cached };
  }

  /** 从已探测的目录里取该宿主的默认模型；没探测过就是 null。 */
  defaultSelection(hostName) {
    const cached = this.cache?.value.hosts.find(item => item.host === hostName && item.ok);
    if (!cached) return null;
    const catalog = cached.catalog;
    const model = catalog.models.find(item => item.key === catalog.defaultModel)
      ?? catalog.models.find(item => item.isDefault)
      ?? catalog.models[0];
    if (!model) return null;
    return {
      model_provider: model.provider ?? null,
      model: model.id,
      reasoning_effort: model.defaultReasoningEffort ?? null,
    };
  }

  async validate(member, { model_provider, model, reasoning_effort } = {}) {
    if (model === undefined || model === null || String(model).trim() === '') return null;
    const catalog = await this.list({ refresh: true, host: member.host });
    const hostCatalog = catalog.hosts.find(item => item.host === member.host && item.ok && item.catalog);
    if (!hostCatalog) throw new Error(`宿主 ${member.host} 没有可用模型目录`);
    const provider = typeof model_provider === 'string' && model_provider.trim() ? model_provider.trim() : null;
    const selected = hostCatalog.catalog.models.find(item => item.id === model && (!provider || item.provider === provider));
    if (!selected) throw new Error('选择的模型不在该成员宿主目录中');
    const supported = selected.reasoningEfforts.length ? selected.reasoningEfforts : hostCatalog.catalog.reasoningEfforts;
    const effort = reasoning_effort ?? selected.defaultReasoningEffort;
    if (!effort || (supported.length && !supported.some(item => item.id === effort))) throw new Error('模型思考强度不受支持');
    return { model_provider: selected.provider ?? provider ?? null, model: selected.id, reasoning_effort: effort };
  }

  // 互动卡执行器走同步应用：卡创建时已完成目录校验，这里只落库；
  // 若目录此后变化，由成员下一回合的宿主错误暴露，可再次调整。
  apply(groupId, memberId, selection) {
    const member = this.bus.resolveMember(groupId, memberId);
    teamsAgg.updateMemberModel(this.bus.store, member.id, selection);
    this.bus.notify(groupId, member.id, `你的模型配置已调整为 ${memberModelSummary(selection)}`);
    return this.bus.store.member(member.id);
  }

  async set(groupId, memberId, selection) {
    const member = this.bus.resolveMember(groupId, memberId);
    const validated = await this.validate(member, selection);
    return this.apply(groupId, member.id, validated);
  }

  /** 服务停止：中止还在跑的探测，并等它们收尾。 */
  abort() {
    for (const controller of this.controllers.values()) controller.abort(new Error('服务正在停止'));
  }

  async settled() {
    await Promise.allSettled([...this.pending.values()]);
  }
}
