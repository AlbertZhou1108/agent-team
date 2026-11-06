import type { MessageAttachment } from '@/shared/api/raw-types';

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
export type TurnStatus = 'running' | 'completed' | 'error' | 'cancelled' | 'stopped' | 'unknown';
/** 执行者宿主:决定按哪套 schema 解释事件。 */
export type Host = 'codex' | 'claude' | 'dsh' | 'unknown';

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
  /** 事件只取到一页:steps 只反映已加载部分,不能当成完整轨迹。 */
  truncated?: boolean;
  /** 已加载事件数 / 回合事件总数,仅 truncated 时有意义。 */
  loadedEvents?: number;
  totalEvents?: number;
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
  /** 产出这条消息的回合;无回合(用户输入/系统通知)时缺省。 */
  turnId?: string | null;
  /** 结构化消息附件;只有携带附件的用户消息才有。 */
  attachments?: MessageAttachment[];
}
