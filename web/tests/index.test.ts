import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOLS,
  TOOL_SLOTS,
  TOOL_SLOT_LABELS,
  builtinTool,
  enabledToolsOf,
  activeMounts,
  isMountVisible,
  navToolEntries,
  type ToolDefinition,
} from '@/tools/index';

describe('内置工具注册表', () => {
  it('每个工具都满足挂载契约不变式', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.id).toMatch(/^builtin\./);
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.mounts.length).toBeGreaterThan(0);
      const slots = tool.mounts.map(mount => mount.slot);
      // 同一槽位最多声明一次。
      expect(new Set(slots).size).toBe(slots.length);
      for (const slot of slots) expect(TOOL_SLOTS).toContain(slot);
      // 左导航是全局位置:必须是 global 工具且带路由。
      for (const mount of tool.mounts) {
        if (mount.slot === 'left-nav') {
          expect(tool.scope).toBe('global');
          expect(mount.routeName).toBeTruthy();
        }
      }
    }
  });

  it('首批工具的挂载位置符合设计意图', () => {
    // 协调遥测只进工具页;详情卡片与左栏组件是保留通路,暂无内置消费者。
    const coordination = builtinTool('builtin.coordination')!;
    expect(coordination.mounts.map(mount => mount.slot)).toEqual(['right-tools']);
    const notes = builtinTool('builtin.notes')!;
    expect(notes.mounts.map(mount => mount.slot)).toEqual(['left-nav', 'right-tools']);
  });

  it('每个槽位都有统一的中文称呼', () => {
    for (const slot of TOOL_SLOTS) {
      expect(TOOL_SLOT_LABELS[slot].length).toBeGreaterThan(0);
    }
  });
});

describe('enabledToolsOf', () => {
  const byId = (tools: ToolDefinition[]) => tools.map(tool => tool.id);

  it('默认全启用;禁用的工具被整体过滤', () => {
    expect(enabledToolsOf({})).toHaveLength(BUILTIN_TOOLS.length);
    expect(byId(enabledToolsOf({ disabled: { 'builtin.notes': true } }))).not.toContain('builtin.notes');
  });

  it('未知工具 id 的记录不影响任何人', () => {
    expect(enabledToolsOf({ disabled: { 'builtin.ghost': true } })).toHaveLength(BUILTIN_TOOLS.length);
  });
});

describe('isMountVisible', () => {
  const notes = builtinTool('builtin.notes')!;
  const quickInput = notes.mounts.find(mount => mount.slot === 'right-tools')!;

  it('工具禁用压过一切:挂载再未隐藏也不显示', () => {
    expect(isMountVisible(notes, quickInput, { disabled: { 'builtin.notes': true } })).toBe(false);
  });

  it('挂载级隐藏只影响那一个位置', () => {
    const prefs = { hidden: { 'builtin.notes:right-tools': true } };
    expect(isMountVisible(notes, quickInput, prefs)).toBe(false);
    const nav = notes.mounts.find(mount => mount.slot === 'left-nav')!;
    expect(isMountVisible(notes, nav, prefs)).toBe(true);
  });

  it('未知键与空状态都按显示处理', () => {
    expect(isMountVisible(notes, quickInput, {})).toBe(true);
    expect(isMountVisible(notes, quickInput, { hidden: { 'builtin.ghost:left-nav': true } })).toBe(true);
  });
});

describe('activeMounts', () => {
  it('按槽位取挂载,内容与归属都在', () => {
    const mounts = activeMounts('right-tools', {});
    expect(mounts.map(entry => entry.tool.id)).toEqual(['builtin.coordination', 'builtin.notes']);
    expect(mounts[0]!.mount.component).toBeTruthy();
  });

  it('挂载级隐藏只影响那一个槽位', () => {
    const prefs = { hidden: { 'builtin.coordination:right-tools': true } };
    expect(activeMounts('right-tools', prefs).map(entry => entry.tool.id)).toEqual(['builtin.notes']);
  });

  it('置顶排在顺序之前,且不改写拖拽出来的顺序', () => {
    const prefs = {
      order: { 'right-tools': ['builtin.notes:right-tools', 'builtin.coordination:right-tools'] },
      pinned: { 'right-tools': ['builtin.coordination:right-tools'] },
    };
    expect(activeMounts('right-tools', prefs).map(entry => entry.tool.id))
      .toEqual(['builtin.coordination', 'builtin.notes']);
    // 取消置顶后回到 order 里的位置:随心记本来就排在前面。
    const unpinned = { ...prefs, pinned: { 'right-tools': [] } };
    expect(activeMounts('right-tools', unpinned).map(entry => entry.tool.id))
      .toEqual(['builtin.notes', 'builtin.coordination']);
  });

  it('多个置顶按置顶先后排列,其余仍按 order', () => {
    const prefs = {
      order: { 'right-tools': ['builtin.notes:right-tools', 'builtin.coordination:right-tools'] },
      pinned: { 'right-tools': ['builtin.coordination:right-tools'] },
    };
    expect(activeMounts('right-tools', prefs)[0]!.tool.id).toBe('builtin.coordination');
  });
});

describe('navToolEntries', () => {
  it('left-nav 挂载生成导航条目,激活态由路由名判定', () => {
    const entries = navToolEntries({}, 'notes');
    expect(entries).toEqual([
      { id: 'builtin.notes', routeName: 'notes', label: '随心记', icon: expect.anything(), current: true },
    ]);
  });

  it('禁用后导航条目消失;团队级工具不进左导航', () => {
    expect(navToolEntries({ disabled: { 'builtin.notes': true } })).toEqual([]);
    const ids = navToolEntries({}).map(entry => entry.id);
    expect(ids).not.toContain('builtin.coordination');
  });
});
