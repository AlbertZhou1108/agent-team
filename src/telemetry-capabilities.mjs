// 兼容查表层:宿主能力声明已下放到各适配器;这里保留既有 telemetryCapabilitiesFor API。
import { capabilities } from './capability-contract.mjs';
import { codexCapabilities } from './hosts/codex.mjs';
import { claudeCapabilities } from './hosts/claude.mjs';
import { dshCapabilities } from './hosts/dsh.mjs';

export { METRIC_KEYS, CONTEXT_KEYS, UNIFIED_FIELDS, capability } from './capability-contract.mjs';

const capabilityBuilders = {
  codex: codexCapabilities,
  claude: claudeCapabilities,
  dsh: dshCapabilities,
};

export function telemetryCapabilitiesFor(host) {
  const build = Object.hasOwn(capabilityBuilders, host) ? capabilityBuilders[host] : null;
  return build ? build() : capabilities(host, {});
}
