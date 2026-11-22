/**
 * 设置域 API 类型:模型观测/目录、模型策略与预设、主题包记录、附件上传设置。
 */

export interface ModelObservation {
  seq: number;
  created: string;
  turnId: string | null;
  type: 'framework.model';
  phase: string;
  model?: string | null;
  models?: string[];
  provider?: string | null;
  reasoningEffort?: string | null;
  source: string;
}

export interface ModelSummary {
  model?: string | null;
  models?: string[];
  reasoningEffort?: string | null;
  phase?: string;
  source?: string;
  seq?: number;
  turnId?: string;
}

export interface ModelState {
  currentModel: ModelSummary | null;
  currentReasoningEffort: ModelSummary | null;
}

export interface CatalogReasoningEffort {
  id: string;
  label: string;
  description?: string;
}

export interface CatalogModel {
  key: string;
  id: string;
  label: string;
  provider?: string;
  description?: string;
  inputModalities?: string[];
  contextWindow?: number;
  reasoningEfforts: CatalogReasoningEffort[];
  defaultReasoningEffort?: string;
  isDefault: boolean;
}

export interface HostModelCatalog {
  version: number;
  host: string;
  source: string;
  defaultModel: string | null;
  reasoningEfforts: CatalogReasoningEffort[];
  models: CatalogModel[];
}

export interface ModelCatalogResponse {
  version: number;
  generatedAt: string;
  cached: boolean;
  hosts: Array<{
    host: string;
    ok: boolean;
    catalog?: HostModelCatalog;
    error?: string;
  }>;
}

export interface ModelsPage extends ModelState {
  observations: ModelObservation[];
  nextAfter: number;
}

export interface ModelPolicy {
  mode: 'smart' | 'user';
  rules: string;
  /** 激活策略的来源配置 id;手动编辑规则时为 null。 */
  preset_id?: string | null;
  created: string;
  updated: string;
}

export interface ModelPolicyPreset {
  id: string;
  name: string;
  mode: 'smart' | 'user';
  rules: string;
  created: string;
  updated: string;
}

/** 服务端存储的主题包:light/dark 是 JSON 字符串,由 client 层解析后交付。 */
export interface ThemePackRecord {
  id: string;
  name: string;
  light: string;
  dark: string;
  created: string;
  updated: string;
}

export interface ModelPolicyDefaults {
  smart: {
    performance: string;
    cost: string;
  };
  user: string;
}

/** 附件上传设置:API 始终传字节/像素/个数,前端负责 MiB/MP 单位换算;从未保存时 updated 为 null。 */
export interface AttachmentSettings {
  maxFileBytes: number;
  maxFilesPerMessage: number;
  maxImagePixels: number;
  updated: string | null;
}
