import { describe, expect, it } from 'vitest';
import {
  matchingEntries,
  navigationEntries,
  withoutDisabledPlugins,
} from '@/features/productivity/navigation';
import { allPluginStaticEntries } from '@/plugins';

describe('withoutDisabledPlugins', () => {
  it('插件禁用后，其静态页面条目不进全局搜索；核心条目不受影响', () => {
    const pluginStatic = allPluginStaticEntries();
    const combined = [...navigationEntries, ...pluginStatic];
    const disabled = { 'builtin.notes': true };
    const ids = withoutDisabledPlugins(combined, disabled).map((entry) => entry.id);
    expect(ids).not.toContain('notes');
    expect(ids).toContain('home');
    expect(matchingEntries(withoutDisabledPlugins(combined, disabled), '随心记')).toEqual([]);
    expect(withoutDisabledPlugins(combined, {}).map((entry) => entry.id)).toContain('notes');
  });

  it('缺 pluginId 的旧最近访问记录按已注册静态条目回查归属', () => {
    const pluginStatic = allPluginStaticEntries();
    const legacyRecent = [
      { id: 'notes', label: '随心记', path: '/notes' },
      { id: 'agent', label: 'Panel Agent', path: '/agent' },
    ];
    expect(
      withoutDisabledPlugins(legacyRecent, { 'builtin.notes': true }, pluginStatic).map(
        (entry) => entry.id,
      ),
    ).toEqual(['agent']);
    expect(withoutDisabledPlugins(legacyRecent, { 'builtin.search': true }, pluginStatic)).toHaveLength(2);
  });
});
