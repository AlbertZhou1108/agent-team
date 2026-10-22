# Confirm Goal Authority and Failure Boundaries

Status: accepted

Date: 2026-10-23

## Decision

- A Goal Draft becomes a Queued Goal only after the user confirms its exact revision and hash.
- A Goal may use the Team Charter's standing authorization, or explicit additional authorization shown in the same Goal Draft confirmation.
- The Main Agent may create and update Goal Drafts but cannot confirm them or expand its own authority.
- If a Main Agent handover cannot confirm that the previous turn ended, the Team enters a handover-attention state. Goal work remains paused, and the user may retry the stop, force the handover with stale-control writes fenced, or cancel the handover.
- A failed Agent Turn does not automatically terminate its Goal. Work may become blocked, retry, or be cancelled with evidence while the Goal remains manageable by the Main Agent.
- A Goal becomes `terminated` only through explicit user termination or when the framework can no longer preserve Goal consistency.
