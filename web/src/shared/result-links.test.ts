import { describe, it, expect } from 'vitest';
import { resultLink } from './result-links';
describe('result file links', () => {
  it('uses the current conversation scope and preserves unrelated links', () => {
    const target = resultLink('/Users/me/工作/result.txt', { group: 'team' });
    const url = new URL(target, 'http://local');
    expect(url.pathname).toBe('/api/files');
    expect(url.searchParams.get('group')).toBe('team');
    expect(url.searchParams.get('path')).toBe('/Users/me/工作/result.txt');
    expect(resultLink('https://example.com/file.txt', { panel: '1' })).toBe('https://example.com/file.txt');
    expect(resultLink('/api/panel-agent/attachments/a', { panel: '1' })).toBe('/api/panel-agent/attachments/a');
    expect(resultLink('/tmp/result.txt')).toBe('/tmp/result.txt');
    expect(resultLink('file://remote/private.txt', { panel: '1' })).toBe('');
  });
});
