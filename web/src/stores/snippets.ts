import { defineStore } from 'pinia';
export type Snippet = { id: string; name: string; text: string; used: number };
const key = 'agent-team:snippets';
function load(): Snippet[] {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (Array.isArray(data))
      return data
        .filter(
          (x) =>
            typeof x.id === 'string' &&
            typeof x.name === 'string' &&
            typeof x.text === 'string',
        )
        .map((x) => ({ ...x, used: Number(x.used) || 0 }));
  } catch {
    /* use defaults */
  }
  return [
    {
      id: 'review',
      name: '审查当前改动',
      text: '请审查当前工作区的改动，优先关注正确性、回归风险和遗漏的边界情况。',
      used: 0,
    },
    {
      id: 'progress',
      name: '汇总当前进展',
      text: '请总结目前完成的工作、已有结果、尚未解决的问题，以及建议的下一步。',
      used: 0,
    },
    {
      id: 'plan',
      name: '整理实施计划',
      text: '请根据这些讨论整理实施计划，说明修改范围和验证方式。',
      used: 0,
    },
  ];
}
export const useSnippets = defineStore('snippets', {
  state: () => ({ items: load() }),
  actions: {
    persist() {
      try {
        localStorage.setItem(key, JSON.stringify(this.items));
      } catch {
        /* session remains editable */
      }
    },
    save(id: string, name: string, text: string) {
      const item = {
        id: id || crypto.randomUUID(),
        name: name.trim(),
        text: text.trim(),
        used: this.items.find((x) => x.id === id)?.used ?? 0,
      };
      if (!item.name || !item.text) return;
      this.items = [item, ...this.items.filter((x) => x.id !== item.id)];
      this.persist();
    },
    remove(id: string) {
      this.items = this.items.filter((x) => x.id !== id);
      this.persist();
    },
    use(id: string) {
      const item = this.items.find((x) => x.id === id);
      if (item) {
        item.used = Date.now();
        this.persist();
      }
    },
  },
});
