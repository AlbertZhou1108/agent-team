import { defineStore } from 'pinia';

export const useConnectionStore = defineStore('connection', {
  state: () => ({
    status: 'connecting' as 'connecting' | 'online' | 'error',
    lastSyncedAt: null as Date | null,
    error: '',
  }),
  actions: {
    online() {
      this.status = 'online';
      this.lastSyncedAt = new Date();
      this.error = '';
    },
    failed(error: unknown) {
      this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error);
    },
  },
});
