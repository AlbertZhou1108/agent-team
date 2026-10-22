import type {
  HostModelCatalog,
  PanelAgentState,
} from '@/shared/api/raw-types';

export interface PanelAgentForm {
  name: string;
  host: string;
  model_provider: string;
  model: string;
  reasoning_effort: string;
}

export interface AvailableHost {
  host: string;
  catalog: HostModelCatalog;
}

export type PanelTeam = PanelAgentState['teams'][number];
export type PanelAction = PanelAgentState['actions'][number];
export type PanelPreparation = PanelAgentState['preparations'][number];
export type PanelUnknownTurn = PanelAgentState['unknown'][number];
