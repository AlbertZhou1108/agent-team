import type { DesktopApplicationStatus, HostStatus } from '@/shared/api/raw-types';

export type HostKind = 'codex' | 'claude' | 'dsh' | 'zcode';
export type HostAvailability = 'available' | 'needs-config' | 'unavailable';
export type CapabilityState = 'available' | 'limited' | 'needs-config' | 'unavailable';

export const HOST_KINDS: HostKind[] = ['codex', 'claude', 'dsh', 'zcode'];

export const HOST_LABELS: Record<HostKind, string> = {
  codex: 'Codex',
  claude: 'Claude',
  dsh: 'DSH',
  zcode: 'ZCode',
};

const DISPLAY_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  dsh: 'DSH',
  zcode: 'ZCode',
  'codex-desktop': 'Codex 桌面应用',
  'claude-desktop': 'Claude 桌面应用',
  'dsh-desktop': 'DSH 桌面应用',
  'zcode-desktop': 'ZCode 桌面应用',
};

/** 用户可见的宿主名称；未知值原样返回，避免设置页出现空白。 */
export function hostDisplayLabel(host?: string | null): string {
  if (!host) return '未选择';
  return DISPLAY_LABELS[host] ?? host;
}

const CLI_NAMES: Record<HostKind, string> = {
  codex: 'codex',
  claude: 'claude',
  dsh: 'dsh',
  zcode: 'zcode',
};

export interface HostCardModel {
  kind: HostKind;
  label: string;
  title: string;
  summary: string;
  availability: HostAvailability;
  stateLabel: string;
}

export interface CapabilityDetail {
  description: string;
  body: string;
}

export interface HostCapability {
  label: string;
  description: string;
  state: CapabilityState;
  /** 非可用状态才带原因；可用时留空，界面也不给「详情」入口。 */
  detail?: CapabilityDetail;
  /** 该行需要额外操作入口，目前只有 CLI 适配器支持在界面内安装。 */
  action?: 'install-cli';
}

export interface HostFact {
  label: string;
  value: string;
}

export interface HostDetailBanner {
  title: string;
  description: string;
}

export function desktopAvailability(item?: DesktopApplicationStatus): HostAvailability {
  if (!item || !item.installed || item.state === 'unavailable') return 'needs-config';
  if (item.userDisabled) return 'unavailable';
  return 'available';
}

export function availabilityLabel(state: HostAvailability): string {
  if (state === 'available') return '可用';
  if (state === 'unavailable') return '不可用';
  return '需配置';
}

export function availabilityVariant(state: HostAvailability): 'success' | 'warning' {
  return state === 'available' ? 'success' : 'warning';
}

function engineAvailable(item: DesktopApplicationStatus): boolean {
  if (item.diagnostics?.engine?.ok !== undefined) return item.diagnostics.engine.ok;
  return item.state === 'available' || item.state === 'pull-only';
}

export function desktopSummary(item?: DesktopApplicationStatus): string {
  if (!item || !item.installed) return '未检测到桌面应用';
  if (item.userDisabled) return '已停用';
  if (item.state === 'unavailable') return item.reason ?? '桌面应用检测未通过';
  if (!engineAvailable(item)) return '桌面应用已检测 · 内置引擎不可用';
  return '桌面应用已检测 · 内置引擎可用';
}

export function cliHostName(kind: HostKind): string {
  return CLI_NAMES[kind];
}

export function cliAvailability(host?: HostStatus): HostAvailability {
  if (!host || host.status === 'missing' || host.status === 'error' || host.status === 'unchecked' || host.status === 'checking') return 'needs-config';
  return 'available';
}

export function hostCardModel(kind: HostKind, item?: DesktopApplicationStatus): HostCardModel {
  const label = HOST_LABELS[kind];
  const availability = desktopAvailability(item);
  return {
    kind,
    label,
    title: `${label} 桌面应用`,
    summary: desktopSummary(item),
    availability,
    stateLabel: availabilityLabel(availability),
  };
}

export function detailBanner(item?: DesktopApplicationStatus): HostDetailBanner {
  if (!item || !item.installed) {
    return { title: '未检测到桌面应用。', description: '可重新检测或重新接入后再查看详情。' };
  }
  if (item.userDisabled) {
    return { title: '该桌面应用已停用。', description: '启用后可继续使用主控与内置执行引擎。' };
  }
  if (item.state === 'unavailable') {
    return { title: '桌面应用暂不可用。', description: item.reason ?? '请重新检测或重新接入。' };
  }
  if (item.state === 'pull-only') {
    return {
      title: '可收发任务，但当前仅支持 Pull-only；新任务由会话拉取。',
      description: item.lifecycleNote ?? '配置文件写入桌面应用后，按应用要求重启后再使用。',
    };
  }
  return {
    title: '桌面应用与内置执行引擎均已就绪，可作为主控或成员执行任务。',
    description: 'CLI 适配器状态按探测结果展示。',
  };
}

function reasonText(values: Array<string | null | undefined>): string {
  const text = values
    .filter((value): value is string => Boolean(value && value.trim()))
    .join('\n\n');
  return text || '探测未返回更多信息。';
}

export function detailCapabilities(kind: HostKind, item?: DesktopApplicationStatus, cli?: HostStatus): HostCapability[] {
  const available = item?.state === 'available';
  const pullOnly = item?.state === 'pull-only';
  const engineOk = item ? engineAvailable(item) : false;
  const cliState = cliAvailability(cli);
  const controller = item?.diagnostics?.controller;
  const engine = item?.diagnostics?.engine;

  return [
    {
      label: '桌面主控',
      description: available
        ? '当前桌面会话可创建和指挥团队。'
        : pullOnly
          ? '桌面会话可收发任务；框架不主动唤醒。'
          : '桌面主控暂不可用。',
      state: available ? 'available' : pullOnly ? 'limited' : 'unavailable',
      detail: available
        ? undefined
        : {
          description: pullOnly
            ? '桌面会话可收发任务，但框架无法主动唤醒；新任务只能由会话拉取。'
            : '桌面主控当前不可用，以下为探测结论。',
          body: reasonText([item?.reason, controller?.reason ?? controller?.detail, item?.lifecycleNote]),
        },
    },
    {
      label: '内置执行引擎',
      description: engineOk
        ? '使用内置 CLI 执行成员任务，运行在隔离目录。'
        : '内置执行引擎暂不可用。',
      state: engineOk ? 'available' : 'unavailable',
      detail: engineOk
        ? undefined
        : {
          description: '内置执行引擎当前不可用，以下为探测结论。',
          body: reasonText([engine?.reason ?? engine?.detail, item?.reason]),
        },
    },
    {
      label: 'CLI 适配器',
      description: cliState === 'available'
        ? '适配器探测显示本机 CLI 可用。'
        : '适配器探测显示本机 CLI 需配置。',
      state: cliState === 'available' ? 'available' : 'needs-config',
      action: 'install-cli',
      detail: cliState === 'available'
        ? undefined
        : {
          description: '检测运行服务的机器上能否通过适配器与宿主通信；检测不会发送模型消息。',
          body: reasonText([cli?.reason]),
        },
    },
  ];
}

export function detailFacts(item?: DesktopApplicationStatus): HostFact[] {
  if (!item) return [];
  return [
    { label: '接入', value: item.installed ? '已配置' : '未配置' },
    { label: '最近验证', value: item.verifiedAt ? '已验证' : '未验证' },
    { label: '桌面应用', value: item.bundleVersion ?? '未知版本' },
    { label: '内置引擎', value: item.engineVersion ?? '未知版本' },
  ];
}

export function capabilityLabel(state: CapabilityState): string {
  if (state === 'available') return '可用';
  if (state === 'limited') return '仅拉取';
  if (state === 'unavailable') return '不可用';
  return '需配置';
}

export function capabilityVariant(state: CapabilityState): 'success' | 'warning' {
  return state === 'available' ? 'success' : 'warning';
}
