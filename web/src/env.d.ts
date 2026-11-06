/// <reference types="vite/client" />

/**
 * 桌面壳经 preload 可选注入的能力。浏览器入口里这个对象不存在，
 * 调用方必须写成 globalThis.agentTeam?.xxx?.() 并保留 HTTP 回退。
 */
interface AgentTeamDesktop {
  isDesktop: boolean;
  retryService(): Promise<boolean>;
  chooseDirectory(): Promise<{ path: string | null }>;
}

declare var agentTeam: AgentTeamDesktop | undefined;

