export type StepKind =
  | 'input'
  | 'output'
  | 'tool'
  | 'reasoning'
  | 'model'
  | 'checkpoint'
  | 'terminal'
  | 'error'
  | 'unknown';

export type StepStatus = 'running' | 'success' | 'error' | 'unknown';
export type TurnStatus = 'running' | 'completed' | 'error' | 'unknown';

export interface TraceStep {
  id: string;
  turnId: string | null;
  kind: StepKind;
  status: StepStatus;
  title: string;
  summary?: string;
  detail?: string;
  sourceEvents: number[];
  raw: unknown[];
  sortSeq: number;
}

export interface TurnView {
  id: string;
  status: TurnStatus;
  steps: TraceStep[];
  firstSeq: number;
  lastSeq: number;
}

export interface MessageView {
  id: string;
  seq: number;
  pairKey: string;
  senderName: string;
  recipientName: string;
  senderIsLead: boolean;
  senderIsUser: boolean;
  kind: 'send' | 'note' | 'system';
  text: string;
  createdAt: string;
}
