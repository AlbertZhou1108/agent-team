/**
 * @template {{ methods: string[], matches: (url: URL) => boolean }} T
 * @param {T[]} routes
 * @param {string | undefined} method
 * @param {URL} url
 */
export function matchRoute(routes, method, url) {
  return routes.find(route => route.methods.includes(method ?? '') && route.matches(url));
}
