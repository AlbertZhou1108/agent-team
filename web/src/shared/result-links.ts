export interface ResultScope { group?: string; panel?: string }
export function resultLink(href: string, scope?: ResultScope | null): string {
  if (!scope || (!scope.group && !scope.panel)) return href;
  // Leave web, app, attachment and anchor links intact. Only explicit local file references qualify.
  const local = href.startsWith('file:') || /^[a-z]:[\\/]/i.test(href)
    || /^\/(?:Users|Library|home|tmp|private|var|Volumes|mnt)\//.test(href)
    || href.startsWith('./') || href.startsWith('../')
    || /^(?![a-z]+:)[^?#:]+\.(?:txt|md|csv|json|pdf|docx|xlsx|pptx|png|jpe?g|svg|html|zip)$/i.test(href);
  if (!local) return href;
  let path = href;
  if (href.startsWith('file:')) {
    try { const url = new URL(href); if (url.hostname && url.hostname !== 'localhost') return ''; path = decodeURIComponent(url.pathname); if (/^\/[a-z]:\//i.test(path)) path = path.slice(1); }
    catch { return ''; }
  }
  return `/api/files?${new URLSearchParams({ ...(scope.group ? { group: scope.group } : { panel: scope.panel! }), path })}`;
}
