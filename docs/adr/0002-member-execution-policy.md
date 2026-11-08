# Member execution policy is the host capability intersection

Status: accepted

## Context

Teams can contain hosts with different enforcement mechanisms. Treating a Group policy as an all-member compatibility gate would block an entire team when one host cannot enforce workspace writes, even when other members can safely do the work. Silently granting every member the team ceiling would instead overstate permissions.

## Decision

Group policy is a ceiling. Each Member execution policy records the ceiling, the mode actually available on that host, and the reason for any downgrade. A safe downgrade, such as workspace writes becoming read-only, does not require extra confirmation but must be visible in the control plane and task context. Existing members and the rest of the team continue working.

Capability loss after creation follows the same rule: incompatible new work stops for the affected member, existing work follows its host outcome, and the framework never substitutes a wider permission or fallback model.

Member capability is represented by stable facts such as file reads, workspace writes, shell execution, and path-boundary enforcement rather than only a policy label. A work dispatch may declare optional required capabilities; the framework rejects the dispatch before recording a work request when the target member cannot satisfy them. Plain messages remain plain messages, and the framework does not infer capability requirements from natural language.

Model-only changes preserve the member's host conversation when the host supports per-turn model overrides. Changes to execution policy, available tools, path boundaries, or MCP configuration require a clean member conversation. Members may request a change through `ask`, but requests never grant authorization: only an explicit user or controller action can apply model or capability changes. Headless member model configuration is validated only on explicit creation or update calls and takes effect on the next member turn.

## Considered options

- Reject a Group policy unless every member host supports it: safest in isolation, but blocks otherwise valid mixed-host teams.
- Apply the Group ceiling to every member without a host check: preserves availability but creates a false permission claim.

## Consequences

The framework must persist and expose effective member policy, re-evaluate host compatibility when capabilities change, and keep task routing and UI language tied to the effective value rather than the group ceiling.
