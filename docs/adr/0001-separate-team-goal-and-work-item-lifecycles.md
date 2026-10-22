# Separate Team, Goal, and Work Item Lifecycles

Status: accepted

Date: 2026-10-23

## Context

The current `team_state.phase` describes an execution cycle even though the Team is intended to remain available between cycles. This conflates whether a Team can communicate with whether a Goal is executing, prevents the Team from remaining open without a Goal, and makes post-Goal communication look like a suspended execution phase.

Team, Goal, and Work Item also need different ownership and lifecycles. A Main Agent controls a Team, manages the Team's Goals, and changes independently of a Goal. A Goal is one contract-bounded execution cycle. A Work Item is concrete work inside one Goal.

## Decision

Treat Team, Goal, and Work Item as separate domain objects:

- A Team is a persistent communication space with an `open` or `archived` state.
- The Main Agent relationship belongs to the Team, not to a Goal.
- A Goal belongs to a Team and has the lifecycle `queued`, `active`, `finalizing`, `completed`, `terminated`, or `cancelled`.
- A Team has at most one Current Goal, where Current means `active` or `finalizing`.
- A Team may be open with no Current Goal and continue ordinary communication.
- Messages belong to a Team and may optionally reference a Goal or Work Item.
- A Goal Draft is editable and can be deleted. It is not a Goal.
- Confirming a Goal Draft appends a Goal to the Goal Queue.
- A Team may have multiple Goal Drafts and multiple Queued Goals.
- Creating a Team does not require creating a Goal Draft, although the normal product flow may create a Team and its first Goal Draft together.
- Users control queue order. When no Current Goal exists, the scheduler activates the first Goal that passes pre-start eligibility checks.
- An ineligible Queued Goal keeps its queue position and is skipped without becoming cancelled or moving to the end.
- A Queued Goal may be cancelled before activation and becomes `cancelled`; it never returns to a Goal Draft.
- Pre-start eligibility only establishes that execution may be attempted. It does not predict execution success.
- Failures after activation are handled by the Current Goal's failure, termination, or recovery flow and never return the Goal to the queue automatically.
- `finalizing` freezes new Goal work but does not close Team communication. A Goal message cutoff provides a stable boundary for finalization while later Team chat continues.
- Archiving is explicit and reversible from settings. An archived Team keeps its history, Goal Drafts, and Goal Queue but accepts no new messages and starts no Goals; a Team with a Current Goal cannot be archived.
- Restoring an archived Team resumes queue scheduling without changing Goal Draft or Queued Goal order.
- Existing Teams whose current Goal is already completed migrate to Team state `open`; archiving remains an explicit later user action.

## Consequences

Team state can no longer be read from `team_state.phase`. Execution phase, goal version, contract, queue position, cutoff, outcome, and final delivery move to Goal-owned persistence, while Team state and Main Agent control remain Team-owned.

Work Items, evidence, runtime attempts, and user outputs must resolve their Goal explicitly rather than inferring it from a Team-wide current version. Message context must distinguish Team chat from Goal-bound messages.

The UI must show Team availability separately from the presence and phase of a Current Goal. It must also expose Goal Drafts and the user-ordered Goal Queue without presenting a completed Goal as a closed or archived Team.
