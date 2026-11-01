import type { ComputedRef, InjectionKey, Ref } from 'vue';
export type MessageReference = {
  id: string;
  seq: number;
  sender: string;
  text: string;
};
export type ReferenceContext = {
  items: Ref<MessageReference[]>;
  enabled: ComputedRef<boolean>;
  add: (item: MessageReference) => void;
};
export const referenceContext: InjectionKey<ReferenceContext> = Symbol(
  'conversation-references',
);
export function referenceText(items: MessageReference[], text: string) {
  return [
    ...items.map(
      (item) =>
        `> 引用消息 #${item.seq} · ${item.sender.replace(/[\r\n]/g, ' ')} · ${encodeURIComponent(item.id)}\n${item.text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}`,
    ),
    text,
  ]
    .filter(Boolean)
    .join('\n\n');
}
export function parseReferences(text: string) {
  const items: MessageReference[] = [];
  let rest = text;
  while (rest.startsWith('> 引用消息 #')) {
    const match = rest.match(
      /^> 引用消息 #(\d+) · ([^\n]+) · (\S+)\n((?:> [^\n]*(?:\n|$))+)/,
    );
    if (!match) break;
    let id: string;
    try {
      id = decodeURIComponent(match[3]!);
    } catch {
      break;
    }
    items.push({
      id,
      seq: Number(match[1]),
      sender: match[2]!,
      text: match[4]!
        .trimEnd()
        .split('\n')
        .map((line) => line.slice(2))
        .join('\n'),
    });
    rest = rest.slice(match[0].length).replace(/^\n+/, '');
  }
  return { items, text: rest };
}
