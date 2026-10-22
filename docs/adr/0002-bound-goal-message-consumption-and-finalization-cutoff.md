# Bound Goal Messages by Context and Freeze Finalization with a Message Cutoff

Status: accepted

Date: 2026-10-23

## Context

The Team remains open while a Goal executes, so new Team messages can arrive during finalization. Treating every message linked to a Work Item as a pending main-Agent report conflates peer communication with Goal Inbox delivery, while treating all new messages as completion blockers prevents a Goal from ever reaching a stable finalization boundary.

Message content remains natural language. The framework must not guess whether text is a formal report before applying delivery semantics.

## Decision

- Every Team message belongs to its Team and has a monotonic Team message sequence.
- A Goal-bound Message optionally references exactly one Goal and may reference a Work Item.
- A Goal Inbox Message is a Goal-bound Message whose recipient is the Team's current Main Agent.
- Goal Peer Messages and Team Chat do not delay Goal completion.
- A Goal Inbox Message becomes consumed only when it enters a Main Agent coordination turn and that turn ends normally.
- The framework does not require a separate acknowledgement action or classify message content as progress, report, or evidence.
- A message becomes Goal evidence only when Goal work explicitly references it.
- Entering `finalizing` captures the latest Team message sequence as the Goal's Finalization Cutoff.
- The finalization gate considers only unconsumed Goal Inbox Messages for the Current Goal whose sequence is at or before the cutoff.
- Goal Inbox Messages after the cutoff remain visible and deliverable but do not automatically delay completion.
- The Main Agent may withdraw finalization after receiving a late message. A later finalization captures a new cutoff.
- Completing the Goal does not reopen it when late messages arrive; subsequent work requires a new Goal.

## Consequences

Message context must carry an optional Goal ID in addition to any Work Item ID. Finalization cannot infer Goal membership solely from Work Item links.

The current disposition-per-message completion gate is unnecessary. Delivery evidence should come from the coordination turn that included the message and its normal terminal state.

The UI may display Goal Peer Messages and post-cutoff messages without presenting them as unresolved reports blocking the Current Goal.
