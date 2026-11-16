// 兼容查表层:宿主能力声明已按宿主收敛在 hosts/definitions.mjs；
// 这里保留既有 telemetryCapabilitiesFor API。
import { capabilities } from './capability-contract.mjs';
import { HOST_DEFINITIONS } from './hosts/definitions.mjs';

export { METRIC_KEYS, CONTEXT_KEYS, UNIFIED_FIELDS, capability } from './capability-contract.mjs';

const capabilityBuilders = Object.fromEntries(
  [...HOST_DEFINITIONS].map(([name, definition]) => [name, definition.telemetryCapabilities]),
);

export function telemetryCapabilitiesFor(host) {
  const build = Object.hasOwn(capabilityBuilders, host) ? capabilityBuilders[host] : null;
  return build ? build() : capabilities(host, {});
}
