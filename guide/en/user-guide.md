# User Guide

[Back to README](../../README.en.md) · [简体中文](../user-guide.md) · [Quick Start](quick-start.md) · [CLI Reference](cli.md)

## Where to Assign Work

| Entry Point | Purpose | Where Messages Go |
| --- | --- | --- |
| Private Assistant (Panel Agent) | Q&A, scoping, observing all teams, handing off requests | Private session; chats are not auto-copied to teams |
| Team Page | Give instructions, add context, read summaries | Sent to the team's active Main Agent (queued if busy) |
| Members & Pair Views | Inspect roles, profiles, and pair conversations | Visibility into collaboration; members do not share one context |
| Notes (Sidebar) | Capture rough thoughts; optionally hand off to Panel Agent | Saved locally without sending; "Send to Panel Agent" drafts a prompt for your confirmation |

When the Panel Agent submits a request to a team, source links connect both sides and team receipts carry source references. Direct team chats are not copied into private history, and team notifications do not wake the private model automatically.

## Creating & Organizing Teams

When creating a team from the UI, provide a brief and workspace folder (`read-only` by default; explicitly enable `workspace-write` when members should create or edit files). The Main Agent coordinates and summarizes while members collaborate in their own conversations.

The Panel Agent can also create teams from explicit requests, observe shared team records, and ask via an interaction card to take over or hand back Main Agent coordination—switching control only after you approve.

Task division, review, progress, and delivery happen in real messages. The optional task panel displays member-maintained task lists and is not an automated quality verifier or workflow enforcer.

## Answering Interaction Cards

When an assistant needs a choice or extra input, it renders an interaction card (multiple-choice or free-text). Your answer feeds back as a user message: Main Agent cards route to the coordination session, member cards route to an isolated "User <-> Member" conversation, and Panel Agent cards return to private chat.

Interaction cards and team charters provide context and consultation—**they are not file-permission gates**. Actual read/write permissions remain governed by the team execution policy and host sandbox.

## Files & Deliverables

- The Panel Agent supports TXT and PNG attachment copies (limits configurable in Settings and enforced server-side). PDF and Office uploads are not supported here.
- Private and team workspaces are chosen separately.
- Local file links in replies download regular files inside the active workspace; escaping via relative paths, symlinks, or accessing internal framework data is rejected.
- A member claiming "done" does not mean independent review passed—ask for concrete file paths, verification steps, and message references before proceeding.

## Workbench, Search & Snippets

The home workbench aggregates unread counts, active runs, recent activity, and on-demand progress summaries (generating a summary invokes the Panel Agent model rather than running continuously in the background).

- **Unread**: Lists one row per conversation with unread messages plus pending interaction cards—matching the desktop Dock and tray badge total. Only messages directed to you (controller reports, Panel Agent replies, delivery-failure notices) increment unread; peer agent-to-agent messages do not. Scrolling to the bottom while the window is visible advances the read watermark. Dismissing a row hides pending cards only and does not clear unread counts.
- **No Response**: Under active runs, lists directives or inter-agent requests waiting more than 5 minutes without a final reply. This is an audit view that does not increment Dock badges; dismissing hides rows from the workbench without deleting records.
- **Search & Snippets**: Use sidebar search or `⌘K` / `Ctrl+K` to find teams, members, messages, pages, and settings. Composer snippets insert reusable prompt drafts for manual editing and sending; message menus support quoting prior messages.

## Notes

The sidebar **Notes** view lets you jot down unformed ideas (only body text is required; title derives from the first line; todo/due fields are optional). Notes have three simple states—active, done, archived—and do not track execution pipelines.

Adding a note from a team's right-hand Tools panel attaches a **source team** tag (retained as "Deleted team" if that team is later permanently removed). Clicking **Send to Panel Agent** switches to private chat with a prefilled prompt—the assistant reads your note against the current workspace and responds with concrete next steps, blockers, or clarifying questions without modifying files or rewriting your note unasked.

Archived notes hide from the main list and can be restored anytime; permanent deletion is available only for archived notes.

## Archiving & Restoring

Archiving pauses team delivery while preserving history and can be restored from Settings. Archiving does not mark work as accepted and does not delete workspace files. Removing a member permanently ends that role and revokes access while keeping its name reserved in team history.

## Troubleshooting

| Symptom | Suggested Action |
| --- | --- |
| Tool missing or unavailable | Inspect the reason; fix installation, login, or host config in that CLI, then re-probe |
| Request timed out | Refresh status first and use the existing retry entry rather than recreating the team |
| Message failed | Inspect the error; retrying preserves the original directive key without treating failures as executed |
| Pending verification (`unknown`) | Verify the host subprocess actually stopped, then clear via the verify control (never auto-replayed) |
| Empty private chat after restart | Click History; new sessions display separately from prior restarts |

See [Limitations & Security](limitations.md) for full operational boundaries.
