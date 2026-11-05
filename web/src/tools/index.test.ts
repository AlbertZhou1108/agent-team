import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOLS,
  TOOL_SURFACE_LABELS,
  TOOL_SURFACES,
  builtinTool,
  enabledTools,
  navToolEntries,
  resolveSurface,
  toolsForSurface,
} from './index';

describe('内置工具注册表', () => {
  it('每个工具的 manifest 都满足契约不变式', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.id).toMatch(/^builtin\./);
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.surfaces.length).toBeGreaterThan(0);
      for (const surface of tool.surfaces) {
        expect(TOOL_SURFACES).toContain(surface);
      }
      expect(tool.surfaces).toContain(tool.defaultSurface);
      // 左导航是全局位置:团队级工具不允许挂上去。
      if (tool.surfaces.includes('nav')) expect(tool.scope).toBe('global');
    }
  });

  it('首批两个工具覆盖 nav 与 details-card 两个侧边栏', () => {
    expect(builtinTool('builtin.notes')?.surfaces).toEqual(['nav']);
    expect(builtinTool('builtin.coordination')?.surfaces).toContain('details-card');
  });

  it('挂载点都有统一的中文称呼', () => {
    for (const surface of TOOL_SURFACES) {
      expect(TOOL_SURFACE_LABELS[surface].length).toBeGreaterThan(0);
    }
  });
});

describe('enabledTools', () => {
  it('默认全启用;禁用的工具被过滤,其余保留', () => {
    expect(enabledTools({})).toHaveLength(BUILTIN_TOOLS.length);
    const result = enabledTools({ 'builtin.notes': true });
    expect(result.map(tool => tool.id)).not.toContain('builtin.notes');
    expect(result.map(tool => tool.id)).toContain('builtin.coordination');
  });

  it('未知工具 id 的禁用记录不影响任何人', () => {
    expect(enabledTools({ 'builtin.ghost': true })).toHaveLength(BUILTIN_TOOLS.length);
  });
});

describe('resolveSurface', () => {
  const tool = builtinTool('builtin.coordination')!;

  it('没有覆盖时用默认挂载点', () => {
    expect(resolveSurface(tool)).toBe('details-card');
  });

  it('覆盖值在工具声明过的挂载点内才生效', () => {
    expect(resolveSurface(tool, 'right-tab')).toBe('right-tab');
    expect(resolveSurface(tool, 'nav')).toBe('details-card');
    expect(resolveSurface(tool, ' nonsense ')).toBe('details-card');
  });
});

describe('toolsForSurface', () => {
  const prefs = { disabled: {}, surfaces: { 'builtin.coordination': 'right-tab' } };

  it('按生效挂载点分组:位置切换后工具跟着走', () => {
    expect(toolsForSurface('details-card', prefs)).toHaveLength(0);
    const rightTab = toolsForSurface('right-tab', prefs);
    expect(rightTab.map(tool => tool.id)).toEqual(['builtin.coordination']);
  });

  it('禁用的工具不出现在任何挂载点', () => {
    const disabled = { ...prefs, disabled: { 'builtin.coordination': true } };
    expect(toolsForSurface('right-tab', disabled)).toHaveLength(0);
  });
});

describe('navToolEntries', () => {
  it('global 工具生成导航条目,激活态由路由名判定', () => {
    const entries = navToolEntries({}, 'notes');
    expect(entries).toEqual([
      { id: 'builtin.notes', routeName: 'notes', label: '随心记', icon: expect.anything(), current: true },
    ]);
  });

  it('禁用后导航条目消失', () => {
    expect(navToolEntries({ disabled: { 'builtin.notes': true }, surfaces: {} })).toEqual([]);
  });

  it('团队级工具不会出现在左导航', () => {
    const entries = navToolEntries({}, undefined);
    expect(entries.map(entry => entry.id)).not.toContain('builtin.coordination');
  });
});
