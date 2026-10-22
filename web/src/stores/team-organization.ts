import { defineStore } from 'pinia';

type Folder = { id: string; name: string; color?: string; collapsed?: boolean };
type TeamMeta = { folder?: string; color?: string; pinned?: boolean };
const key = 'agent-team:organization';
function load(): { folders: Folder[]; teams: Record<string, TeamMeta>; order: string[] } {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return { folders: Array.isArray(saved.folders) ? saved.folders : [], teams: saved.teams ?? {}, order: saved.order ?? [] };
  } catch { return { folders: [], teams: {}, order: [] }; }
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
    color(id: string, color?: string, folder = false) {
      if (folder) { const item = this.folders.find(item => item.id === id); if (item) item.color = color; }
      else this.teams[id] = { ...this.teams[id], color };
      this.persist();
    },
    togglePin(id: string) { this.teams[id] = { ...this.teams[id], pinned: !this.teams[id]?.pinned }; this.persist(); },
    toggleFolder(id: string) { const folder = this.folders.find(item => item.id === id); if (folder) folder.collapsed = !folder.collapsed; this.persist(); },
  },
});
