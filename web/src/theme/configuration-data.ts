/** Configuration is shared read-only data; resolved output must be owned by its caller. */
export function freezeConfiguration<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freezeConfiguration(child);
  }
  return Object.freeze(value);
}
