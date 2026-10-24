// Groups are created directly; the optional charter is plain text injected
// into turn context, not an authorization gate.
export function confirmedGroup(bus, args, charter = null) {
  return bus.createGroup({ ...args, ...(charter ? { charter } : {}) });
}
