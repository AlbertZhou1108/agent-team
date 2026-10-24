# Revert to a Communication-First Core

Status: accepted

Date: 2026-10-25

Supersedes: [0001](./0001-separate-team-goal-and-work-item-lifecycles.md), [0002](./0002-bound-goal-message-consumption-and-finalization-cutoff.md), [0003](./0003-confirm-goal-authority-and-failure-boundaries.md)

## Context

ADR 0001-0003 grew the framework into an audited workflow machine: contract version chains, a six-state work item machine, goal drafts/queues/versions, message dispositions, finalization cutoffs, and an idempotent operation ledger. Measured against the codebase, roughly 35% of the backend now exists to enforce collaboration process, and it is not isolated: every send passes a phase gate and writes a `message_context` ledger row, the message pump's SQL joins `team_state`, every turn prompt injects contract/work-item/goal projections, and finishing requires a four-way structural audit. Task process now constrains the one thing this project is: a multi-agent communication framework.

Process enforcement was meant to guarantee coordination quality. In practice it taxes simple conversations, slows every turn, and makes host adaptation and panel work follow the process model instead of communication needs.

## Decision

The framework stops enforcing collaboration process. Coordination responsibility returns to the Main Agent and the user, expressed in ordinary messages. The framework keeps only communication and runtime safety.

Removed as framework-enforced machinery:

- Goal lifecycle entirely (`team-goal-lifecycle.mjs`, goal drafts, goal queue, goal versions, Goal Inbox, `next_goal_request`).
- Work items: the state machine, participant roles, artifact versions, review-reference validation, `work_records`.
- Contract version chains, change requests, and the preparation/revision/hash group-creation protocol. Group creation becomes direct; an optional free-text charter travels with the group as prompt context only — never as a gate.
- `team_finish` / `closing` / `closed` phases, `message_dispositions`, and the finalization audit. "Done" is the user archiving the group (existing `groups.state`).
- The per-operation `operationId` ledger for management writes; the operation-level idempotency contract is dropped with the machinery it served.
- The model planning trio (`planMemberSelection`/`validateRolePlan`/`ensureRolePlan`); role models resolve from `--hosts` configuration and the global model policy directly.

Kept, because they are runtime safety or core communication, not task process:

- The message bus: `send`/`note`/`read`, pair conversations, serial coordination, batch merging, message-number identity.
- The turn engine: host adapters, retry/recovery semantics, streaming, telemetry.
- The unknown-runtime gate: turns with unverified outcome still block further dispatch and never auto-replay.
- Directive idempotency numbers for user instructions.
- Host execution policy domains (`communication` / `project`) and sandbox enforcement — but resolved from group/role configuration directly, not derived from contract and work items.
- Member lifecycle (permanent identity, unique names, add/remove/stop) and `groups.state` (open/archived) as the only retained state.

## Consequences

- `store.pending()` no longer joins `team_state` and ignores `message_dispositions`; delivery depends only on recipient existence and the archive switch.
- Send transactions no longer write `message_context`; `runtime_attempts` loses contract/goal columns.
- `requireCommunication` narrows to two checks: group not archived, no unknown runtimes.
- Turn prompts carry group history and the optional charter; contract/work-item/goal projections disappear from `information.mjs`.
- Roughly 3,000 backend lines, ~1,500 frontend lines, and ~1,500 test lines are removed; agent-facing tools drop from ~25 to ~12.
- Long-task coordination quality now depends on the Main Agent's own organization in messages. If real usage shows this is insufficient, structured process may return later as an opt-in layer, not as a default state machine.
- Databases from earlier versions migrate by dropping the process tables; message history is preserved. This is a hard break for pre-existing data: the project is local, single-user, and pre-1.0.
