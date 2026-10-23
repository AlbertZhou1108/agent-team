import { dehydrate, hydrate, type QueryClient } from '@tanstack/vue-query';

const storageKey = 'agent-team:tab-messages:v1';
const messageKeys = new Set(['messages', 'message-history']);

/** Keep history for this tab, including reloads; never persist auth or runtime snapshots. */
export function installTabCache(client: QueryClient, storage: Storage, page: Pick<Window, 'addEventListener' | 'removeEventListener'>) {
  try {
    const saved = storage.getItem(storageKey);
    if (saved) hydrate(client, JSON.parse(saved));
  } catch {
    // An invalid or unavailable browser store must not prevent the panel opening.
    try { storage.removeItem(storageKey); } catch { /* Storage may be disabled. */ }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  function save() {
    clearTimeout(timer);
    timer = undefined;
    try {
      storage.setItem(storageKey, JSON.stringify(dehydrate(client, {
        shouldDehydrateQuery: query => messageKeys.has(String(query.queryKey[0])) && query.state.status === 'success',
        shouldDehydrateMutation: () => false,
      })));
    } catch {
      // Quota failures retain the full in-memory cache for navigation in this tab.
    }
  }
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'success' || !messageKeys.has(String(event.query.queryKey[0]))) return;
    clearTimeout(timer);
    timer = setTimeout(save, 250);
  });
  page.addEventListener('pagehide', save);
  return () => {
    save(); unsubscribe(); page.removeEventListener('pagehide', save);
  };
}
