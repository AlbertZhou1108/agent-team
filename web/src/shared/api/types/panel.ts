/**
 * Panel Agent 域 API 类型:面板代理、私聊消息、流式片段、未读投影与附件 DTO。
 */
import type { Group, TeamRequest, TeamRequestReceipt } from './core';

export type PanelAccess = 'read-only' | 'workspace-write' | 'full-access';

export interface PanelAgent {
  id: string;
  name: string;
  host: string;
  model_provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  workspace: string | null;
  access: PanelAccess;
  created: string;
  updated: string;
}

export interface PanelTeamView extends Group {
  relation: 'observer' | 'main' | null;
  controller: {
    kind: 'member' | 'panel_agent' | 'external_agent';
    id: string;
    name: string;
    assignment?: {
      revision: number;
      state: 'active' | 'suspended';
      original_lead_id: string | null;
    } | null;
  };
}

export interface PanelMessage {
  seq: number;
  id: string;
  panel_agent_id: string;
  context: 'private' | 'coordination' | 'home-summary';
  role: 'user' | 'assistant' | 'system';
  text: string;
  active_team_id: string | null;
  created: string;
  attachments?: MessageAttachment[];
}

// 服务端对同一接口返回两种形状:带附件元数据的会话消息与不带附件的精简行。
// 两者在同文件内做 interface 合并,保持调用方拿到的 PanelMessage 同时兼容两种来源。
export interface PanelMessage {
  seq: number;
  id: string;
  panel_agent_id: string;
  context: 'private' | 'coordination' | 'home-summary';
  role: 'user' | 'assistant' | 'system';
  text: string;
  active_team_id: string | null;
  created: string;
}

/** 附件上传响应:只含展示元数据,不含本机路径或存储名。 */
export interface UploadedAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

/** 消息附件 DTO:服务端按文件现状给出 availability;不含路径或存储名。 */
export interface MessageAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  availability: 'available' | 'missing';
}

export interface PanelAgentState {
  bootId?: string;
  bootSeq?: number;
  requests?: TeamRequest[];
  teamPendingInteractions?: Record<string, number>;
  notifications?: Array<{ id: string; group_id: string; text: string; sourceMessageIds: string[] }>;
  agent: PanelAgent | null;
  sessions: Array<{
    id: string;
    context: 'private' | 'coordination' | 'home-summary';
    group_id: string | null;
    session: string | null;
    updated: string;
  }>;
  teams: PanelTeamView[];
  conversation: PanelMessage[];
  streaming?: PanelStream[];
  running: Array<{ endpoint: string; groupId: string | null; turnId: string; created?: string | null }>;
  unknown: Array<{ turn_id: string; group_id: string | null; detail?: string }>;
}

export interface PanelStream {
  homeSummary?: boolean;
  sourceUserMessageId?: string | null;
  agentId: string;
  sessionId: string;
  turnId: string;
  context: 'private' | 'coordination' | 'home-summary';
  activeTeamId: string | null;
  text: string;
  reasoning?: string;
  /** 服务端维护的回合阶段;旧服务端缺失时前端回落到内容判断。 */
  runPhase?: StreamPhase;
  tool?: StreamTool | null;
  created: string;
  updatedAt: string;
}

export type StreamPhase = 'accepted' | 'thinking' | 'writing' | 'tool';

export interface StreamTool {
  name: string;
  groupId?: string | null;
}

export interface PanelMessagePage { messages: PanelMessage[]; nextBefore: number | null; bootId: string }

export type UnreadMessage = Pick<PanelMessage, 'seq' | 'role' | 'active_team_id'>;
export type UnreadReceipt = Pick<TeamRequestReceipt, 'id' | 'isSourceCopy' | 'sourceMessageIds'>;
export interface UnreadProjection { messages: UnreadMessage[]; receipts: UnreadReceipt[] }
