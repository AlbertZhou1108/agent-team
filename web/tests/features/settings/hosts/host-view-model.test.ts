import { describe, expect, it } from 'vitest';
import type { DesktopApplicationStatus, HostStatus } from '@/shared/api/raw-types';
import {
  availabilityLabel,
  availabilityVariant,
  capabilityVariant,
  capabilityLabel,
  cliAvailability,
  detailCapabilities,
  detailFacts,
  hostCardModel,
} from '@/features/settings/hosts/host-view-model';

const available: DesktopApplicationStatus = {
  kind: 'codex', label: 'Codex', installed: true, state: 'available', reason: null,
  applicationId: 'app-1', bundleVersion: '26.1', engineVersion: '0.169.1',
  verifiedAt: '2026-11-20T00:00:00.000Z', userDisabled: false, lifecycleNote: null, diagnostics: null,
};

const pullOnly: DesktopApplicationStatus = {
  ...available,
  kind: 'dsh',
  label: 'DSH',
  state: 'pull-only',
  applicationId: 'app-2',
  lifecycleNote: '需要手动查看消息',
};

describe('host view model', () => {
  it('collapses available and pull-only into available on the host card', () => {
    expect(hostCardModel('codex', available).stateLabel).toBe('可用');
    expect(hostCardModel('dsh', pullOnly).stateLabel).toBe('可用');
    expect(hostCardModel('dsh', pullOnly).summary).toBe('桌面应用已检测 · 内置引擎可用');
  });

  it('keeps pull-only distinct in detail capabilities', () => {
    const capabilities = detailCapabilities('dsh', pullOnly, { name: 'dsh', status: 'available' });
    expect(capabilities[0].state).toBe('limited');
    expect(capabilityLabel(capabilities[0].state)).toBe('仅拉取');
    expect(capabilities[1].state).toBe('available');
  });

  // 只有不正常的能力项才需要解释，可用项不该带「详情」入口。
  it('attaches a reason only to abnormal capabilities', () => {
    const healthy = detailCapabilities('codex', available, { name: 'codex', status: 'available' });
    expect(healthy.map(item => item.detail)).toEqual([undefined, undefined, undefined]);

    const broken = detailCapabilities('dsh', pullOnly, { name: 'dsh', status: 'error', reason: 'dsh: missing module' });
    expect(broken[0].detail?.body).toContain('需要手动查看消息');
    expect(broken[2].detail?.body).toBe('dsh: missing module');
  });

  it('marks the CLI row as the one that can install in place', () => {
    const capabilities = detailCapabilities('codex', available, { name: 'codex', status: 'missing' });
    expect(capabilities.filter(item => item.action === 'install-cli')).toHaveLength(1);
    expect(capabilities[2].action).toBe('install-cli');
  });

  it('maps missing and error CLI hosts to needs-config', () => {
    const missing: HostStatus = { name: 'claude', status: 'missing' };
    const error: HostStatus = { name: 'claude', status: 'error', reason: 'failed' };
    expect(cliAvailability(missing)).toBe('needs-config');
    expect(cliAvailability(error)).toBe('needs-config');
    expect(availabilityLabel(cliAvailability(missing))).toBe('需配置');
  });

  it('uses one semantic color scale for every state label', () => {
    expect(availabilityVariant('available')).toBe('success');
    expect(availabilityVariant('needs-config')).toBe('warning');
    expect(availabilityVariant('unavailable')).toBe('warning');
    expect(capabilityVariant('available')).toBe('success');
    expect(capabilityVariant('limited')).toBe('warning');
    expect(capabilityVariant('needs-config')).toBe('warning');
    expect(capabilityVariant('unavailable')).toBe('warning');
  });

  it('exposes verified state without inventing timestamps', () => {
    const facts = Object.fromEntries(detailFacts(available).map(fact => [fact.label, fact.value]));
    expect(facts['最近验证']).toBe('已验证');
    expect(facts['桌面应用']).toBe('26.1');
    expect(facts['内置引擎']).toBe('0.169.1');
  });
});
