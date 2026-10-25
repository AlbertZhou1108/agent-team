import type {
  HostModelCatalog,
  PanelAccess,
  PanelAgentState,
} from '@/shared/api/raw-types';

export type { PanelAccess };

export interface PanelAgentForm {
  name: string;
  host: string;
  model_provider: string;
  model: string;
  reasoning_effort: string;
  workspace: string;
  access: PanelAccess;
}

export interface AvailableHost {
  host: string;
  catalog: HostModelCatalog;
}

export type PanelTeam = PanelAgentState['teams'][number];
export type PanelUnknownTurn = PanelAgentState['unknown'][number];
