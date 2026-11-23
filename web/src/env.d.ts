/// <reference types="vite/client" />

/**
 * 桌面壳经 preload 可选注入的能力。浏览器入口里这个对象不存在，
 * 调用方必须写成 globalThis.agentTeam?.xxx?.() 并保留 HTTP 回退。
 */
export type DesktopPlatform = 'win32' | 'darwin' | 'linux' | string;
export type DesktopWindowAction = 'minimize' | 'maximize-toggle' | 'close';
export type DesktopMenuAction =
  | 'show-window'
  | 'open-in-browser'
  | 'reconnect-service'
  | 'stop-service'
  | 'open-guide'
  | 'toggle-devtools'
  | 'close-window'
  | 'quit';

export interface DesktopMenuState {
  hasService: boolean;
  dev: boolean;
  showingError: boolean;
  version: string;
}

export interface AgentTeamDesktop {
  isDesktop: boolean;
  platform?: DesktopPlatform;
  retryService(): Promise<boolean>;
  chooseDirectory(): Promise<{ path: string | null }>;
  windowControl?(action: DesktopWindowAction): Promise<boolean>;
  isMaximized?(): Promise<boolean>;
  onMaximizedChange?(listener: (maximized: boolean) => void): () => void;
  getMenuState?(): Promise<DesktopMenuState>;
  onMenuStateChange?(listener: (state: DesktopMenuState) => void): () => void;
  runMenuAction?(action: DesktopMenuAction): Promise<boolean>;
}

declare global {
  var agentTeam: AgentTeamDesktop | undefined;
}

