import { defineStore } from 'pinia';

type Folder = { id: string; name: string; color?: string; collapsed?: boolean };
type TeamMeta = { folder?: string; color?: string; pinned?: boolean };
const key = 'agent-team:organization';
function load(): {
  folders: Folder[];
  teams: Record<string, TeamMeta>;
  order: string[];
  homePinned: string[];
  homeOrder: string[];
} {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      folders: Array.isArray(saved.folders) ? saved.folders : [],
      teams: saved.teams ?? {},
      order: saved.order ?? [],
      homePinned: Array.isArray(saved.homePinned) ? saved.homePinned : [],
      homeOrder: Array.isArray(saved.homeOrder) ? saved.homeOrder : [],
    };
  } catch { return { folders: [], teams: {}, order: [], homePinned: [], homeOrder: [] }; }
}
export const useTeamOrganization = defineStore('team-organization', {
  state: load,
  actions: {
    persist() { localStorage.setItem(key, JSON.stringify(this.$state)); },
    createFolder(name: string) {
      if (!name.trim()) return;
      const id = crypto.randomUUID();
      this.folders.push({ id, name: name.trim() });
      this.persist();
      return id;
    },
    dissolve(id: string) {
      for (const team of Object.values(this.teams)) if (team.folder === id) delete team.folder;
      this.folders = this.folders.filter(folder => folder.id !== id);
      this.persist();
    },
    move(ids: string[], folder?: string) {
      if (folder && !this.folders.some(item => item.id === folder)) return;
      for (const id of ids) this.teams[id] = { ...this.teams[id], folder };
      this.persist();
    },
    reorderTeams(ids: string[], target: string, after: boolean, allIds: string[]) {
      if (ids.includes(target)) return;
      const metadata = this.teams[target] ?? {};
      for (const id of ids) this.teams[id] = { ...this.teams[id], folder: metadata.folder, pinned: metadata.pinned };
      const order = [...new Set([...this.order, ...allIds])].filter(id => !ids.includes(id));
      const index = order.indexOf(target);
      if (index < 0) return;
      order.splice(index + (after ? 1 : 0), 0, ...ids);
      this.order = order;
      this.persist();
    },
    reorderFolder(id: string, target: string, after: boolean) {
      if (id === target) return;
      const folder = this.folders.find(folder => folder.id === id);
      if (!folder || !this.folders.some(folder => folder.id === target)) return;
      this.folders = this.folders.filter(folder => folder.id !== id);
      this.folders.splice(this.folders.findIndex(folder => folder.id === target) + (after ? 1 : 0), 0, folder);
      this.persist();
    },
    reorderHomeTeams(ids: string[], target: string, after: boolean, allIds: string[]) {
      if (this.homePinned.includes(target)) return;
      const movable = [...new Set(ids)].filter(id => (
        id !== target
        && allIds.includes(id)
        && !this.homePinned.includes(id)
      ));
      if (!movable.length) return;
      const order = [...new Set([...this.homeOrder, ...allIds])]
        .filter(id => !movable.includes(id));
      const index = order.indexOf(target);
      if (index < 0) return;
      order.splice(index + (after ? 1 : 0), 0, ...movable);
      this.homeOrder = order;
      this.persist();
    },
    color(id: string, color?: string, folder = false) {
      if (folder) { const item = this.folders.find(item => item.id === id); if (item) item.color = color; }
      else this.teams[id] = { ...this.teams[id], color };
      this.persist();
    },
    togglePin(id: string) { this.teams[id] = { ...this.teams[id], pinned: !this.teams[id]?.pinned }; this.persist(); },
    toggleHomePin(id: string) {
      this.homePinned = this.homePinned.includes(id)
        ? this.homePinned.filter(item => item !== id)
        : [...this.homePinned, id];
      this.persist();
    },
    toggleFolder(id: string) { const folder = this.folders.find(item => item.id === id); if (folder) folder.collapsed = !folder.collapsed; this.persist(); },
  },
});
