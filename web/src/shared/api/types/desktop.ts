/**
 * 桌面宿主域 API 类型:宿主连接状态与桌面应用检测/校验/安装结果。
 */

export interface HostStatus {
  name: string;
  status: 'available' | 'missing' | 'error' | 'checking' | 'unchecked';
  reason?: string;
  installing?: boolean;
  installation?: { phase: 'checking' | 'installing' | 'verifying' | 'completed' | 'failed'; reason?: string };
}

/** 桌面应用集成的用户可见结论:一行一个应用,诊断细节按检查项展开。 */
export interface DesktopApplicationStatus {
  kind: 'codex' | 'dsh' | 'claude' | 'zcode';
  label: string;
  installed: boolean;
  state: 'available' | 'pull-only' | 'unavailable';
  reason: string | null;
  applicationId: string | null;
  installPath?: string | null;
  bundleVersion?: string | null;
  enginePath?: string | null;
  engineVersion?: string | null;
  verifiedAt?: string | null;
  userDisabled?: boolean;
  lifecycleNote?: string | null;
  diagnostics?: { summary?: string; controller?: { ok?: boolean; reason?: string; detail?: string }; engine?: { ok?: boolean; reason?: string; detail?: string }; timedOut?: boolean } | null;
}

export interface DesktopVerifyResult {
  verified: boolean;
  needsConfirmation?: boolean;
  cost?: string;
  refused?: boolean;
  reason?: string;
  application?: DesktopApplicationStatus;
}

export interface DesktopInstallResult {
  applicationId: string;
  binding: { id: string; name: string; bindingKind: 'activation' | 'conversation'; surface: 'cli' | 'desktop'; host: string };
  configPath?: string;
  socketPath: string;
  backupPath?: string | null;
  manual?: boolean;
  mcpConfig?: Record<string, unknown>;
  limitations?: string[];
  nextStep?: string;
  replacedUserEntry?: boolean;
  enginePath?: string | null;
  engineVersion?: string | null;
}
