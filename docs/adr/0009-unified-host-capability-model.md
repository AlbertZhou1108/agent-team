# Unified host capability model

Status: accepted

## Context

The framework describes the same host twice. A member host is described by `createHost()` → `run(context)` plus a hard-coded `executionCapabilities()` returning `file.read / file.write / filesystem.boundary / shell.exec`. A controller host is described by a separate seven-id contract (`session.identity / deliver / wake / status`, `turn.observe`, `user.elicit`, `notification.native`) whose value is not declared by the adapter at all — `agent-team connect` fills a default of the four required ids plus `session.wake` when a wake driver exists.

The two vocabularies do not intersect, the truth is scattered across adapter code, connect arguments and `wakeDriverFor()`, and session ownership (framework-spawned vs host-owned) is only implied by which code path runs. Inspection also shows that four of the seven controller ids (`identity`, `deliver`, `status`, `turn.observe`) have never been consumed individually — they only ever pass as an all-or-nothing admission ticket. `notification.native` has no implementation anywhere.

## Decision

1. **Unify at the description layer only.** How a host executes stays adapter-specific: `spawn/run` for members and `deliver/wake` for controllers remain separate implementations. The catalog says what a host can do; it does not prescribe how.

   The split is not a framework preference — it follows the host's own shape. Codex and ZCode expose a resident service the framework connects to (app-server), so the host itself queues an injection while a turn is running. DSH and Claude are one-shot CLIs with no resident service, so the framework must spawn a process and take responsibility for conflicts itself. A host does not grow a resident service because the framework wishes it, which is why the execution layer cannot be unified away.

2. **One capability catalog, expressed as framework requirements.** The catalog lists what the framework needs from a host, not what a particular host happens to offer. A requirement with no host declaring it is a normal state, not an error.

3. **Hosts declare; nothing is probed at runtime.** A declaration is development-time evidence: the adapter author ran the capability before writing it down. Re-testing on every connection repeats a conclusion already paid for, so it is not done.

4. **Roles are derived, never stored or declared.** `deriveRoles(capabilities)` is a single global function. A host profile carries no `roles` field, so a role label can never disagree with the capabilities it is supposed to summarise.

5. **No dependency graph.** Capability relationships are absorbed into role derivation instead of a separately maintained relation table. `wake` implies delivery and `round-inspection` implies a stable session; that is written once, in the derivation, as `(deliver || wake)`.

6. **No contradiction checker.** Because relationships are not modelled, there is nothing to check against. Combos that would otherwise contradict are collapsed into one capability — `exec.write` and `exec.shell` mean "inside the workspace", so the boundary is part of the meaning rather than a separate switch.

7. **Failures attribute to declarations.** When a dispatch fails while using a capability the host declared, the error says so. This is the only feedback loop for an overstated declaration, and it costs nothing.

8. **Controller and member are role outcomes, not separate concepts.** There is no controller-only verification step, because there is no controller-only concept to verify.

9. **Declarations are boolean only.** Any capability that would carry several levels is split into independent booleans. `telemetry.tokens` becomes `telemetry.tokens.direct` and `telemetry.tokens.derived`; both false means unsupported. A declaration never mixes booleans and enums.

10. **Host-specific code lives under `hosts/<host>/`.** Shared facilities (registry, catalog, policies, probe, lifecycle, process) stay at the `hosts/` root. A host directory owns its factory, capability declaration, traits and wake driver.

## Capability catalog

| Domain | Id | Meaning | Replaces |
| --- | --- | --- | --- |
| session | `session.spawn` | framework can start a session and hold a full round-trip with it | member factory |
| session | `session.deliver` | can deliver into an existing session (implies a stable identity) | `session.identity`, `session.deliver` |
| session | `session.wake` | can wake an idle session and deliver (implies delivery) | `session.wake` |
| session | `turn.observe` | can observe round start, terminal state and failure | `session.status`, `turn.observe` |
| exec | `exec.read` | can read inside the workspace | `file.read` |
| exec | `exec.write` | can write inside the workspace (boundary is inherent) | `file.write`, `filesystem.boundary` |
| exec | `exec.shell` | can run commands inside the workspace (boundary is inherent) | `shell.exec`, `filesystem.boundary` |
| user | `user.elicit` | can ask the user for a decision | `user.elicit` |
| user | `user.notify` | can raise a native notification (reserved, no implementation yet) | `notification.native` |
| telemetry | `telemetry.tokens.direct` | host reports token counts directly | token metrics |
| telemetry | `telemetry.tokens.derived` | token counts the framework derives from buckets | token metrics |
| telemetry | `telemetry.turn_time` | host-reported round duration | `hostTurnWallMs` |
| telemetry | `telemetry.context_window` | context window size | `contextWindowTokens` |

## Role derivation

```js
function deriveRoles(caps) {
  const roles = [];
  if (caps['session.deliver'] && caps['turn.observe']) roles.push('controller');
  if (caps['session.spawn']) roles.push('member');
  return roles;
}
```

Two roles only. A controller is "the party that decides on your behalf": it can receive messages and see round state. `session.wake` deliberately does not participate — it decides whether the framework can pull the session up, which is a delivery channel, not an identity. A host that cannot be woken is still a controller; it falls back to polling for messages.

`observer` and `participant` were removed. A host that can neither receive nor be started has no place in a team, and "cannot be a member" is not an identity — it is the natural consequence of missing `session.spawn`.

## Derived capabilities

`session.spawn` and `session.wake` are never hand-written:

| Capability | Derived from |
| --- | --- |
| `session.spawn` | whether the definition has a member factory |
| `session.wake` | whether a wake driver is registered |

Everything else is a hand-written boolean. This keeps a single source of truth: a host cannot claim it can be launched when no factory exists, and cannot claim it can be woken when no driver exists.

## Panel agents

Panel agents are controllers by construction and have no capability declaration. The catalog describes external hosts; an internal controller does not need to prove it can receive messages.

## Migration

Capability ids are stored as JSON, so id changes need no schema migration; read paths map old ids to new ones:

- `session.identity` → `session.deliver`
- `session.status` → `turn.observe`
- `file.read` → `exec.read`, `file.write` → `exec.write`, `shell.exec` → `exec.shell`
- `filesystem.boundary` → dropped (inherent in `exec.write` / `exec.shell`)
- `notification.native` → `user.notify`

Writes always use the new ids. Old and new values coexist during the transition because the read path normalises both.

One schema change did happen: **v19 drops `external_client_bindings.probed_capabilities`**. That column was always written with the same value as `declared_capabilities`, so the "declared ∩ probed" intersection could never remove anything. Declarations are now effective as-is; the schema no longer implies a verification step that never ran.

## Considered options

- **Keep two contracts and add a mapping layer.** Cheapest to adopt, but preserves two sources of truth and the vocabulary split that causes the problem.
- **Also unify the execution layer into one `deliver` primitive.** Conceptually cleanest, but Codex sandboxed turns, Claude streaming subprocesses, DSH one-shot resume and ZCode `session/send` differ enough that a universal primitive would be a switch statement in disguise.
- **Verify declared capabilities on every connection.** Produces stronger guarantees at the cost of repeated model spend, and duplicates work already done when the adapter was written.
- **Model capability dependencies explicitly.** Makes contradictions computable, but adds a second structure that must track every framework extension — the maintenance cost this decision exists to avoid.

## Consequences

- Adding a host means writing one declaration object and the execution code it actually needs; no second capability source, no role label to keep in sync.
- The catalog is the only place capabilities exist, so a framework extension adds one row rather than touching every adapter.
- An overstated declaration is only discovered when the capability is used; the failure annotation is the sole mitigation. This is accepted: runtime probing for every connection was judged more expensive than the occasional mis-declaration.
- `user.notify` stays in the catalog without a declared host. That is the correct representation of "the framework wants it, nobody implements it yet".
- The member/controller split disappears from the adapter contract while both execution paths remain distinct. Unification is conceptual, not mechanical.
