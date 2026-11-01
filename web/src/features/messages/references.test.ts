import { describe, it, expect } from 'vitest';
import { referenceText, parseReferences } from './references';
describe('conversation references', () => {
  it('round trips multiple references including multiline text and keeps the user body', () => {
    const items = [
      { id: 'message/a', seq: 3, sender: 'Alice', text: 'first\n\n> nested' },
      { id: 'msg-b', seq: 5, sender: 'Bob', text: 'second' },
    ];
    expect(parseReferences(referenceText(items, '请比较这两段')).items).toEqual(
      items,
    );
    expect(parseReferences(referenceText(items, '请比较这两段')).text).toBe(
      '请比较这两段',
    );
  });
  it('keeps ordinary text and malformed references intact', () => {
    for (const text of [
      '普通消息',
      '> 引用消息 #x',
      '> 引用消息 #1 · A · %xy\n> text',
    ])
      expect(parseReferences(text)).toEqual({ items: [], text });
  });
});
