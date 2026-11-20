# Limitations & Security

[Back to README](../../README.en.md) · [简体中文](../limitations.md) · [User Guide](user-guide.md) · [Architecture](architecture.md)

## Scope

Agent Team is a **local, single-user** collaboration environment. It does not provide multi-user accounts, cross-machine team hosting, or enterprise tenant isolation. The browser UI connects to a local daemon, while host CLIs may contact external model providers—do not treat "local" as fully offline.

v0.5.0 provides macOS arm64, Windows x64, and Linux x64 release archives, all unsigned and unnotarized. Source CI runs across all three OSes, while per-release binary verification depends on each release's notes. Follow OS prompts cleanly without disabling system security protections.

## Hosts & Costs

At least one supported host must be installed and configured. The framework does not manage host logins, API keys, model providers, or quotas, and cannot guarantee indefinite compatibility across upstream CLI updates.

Member self-profiles on creation, user chats, peer collaboration, and manual summaries all consume model calls. Connection probes do not send model prompts, though they may trigger host startup logs or catalog network requests. Workbench stats and activity metrics are not real-time billing ledgers or proof of quality.

## Files & Execution

Permissions are enforced by the team execution policy and host sandbox. Interaction cards, team charters, and role descriptions never expand permissions, and file policies do not enforce full network isolation. Because multiple members sharing a workspace have no framework file lock, assign explicit file ownership and handoffs to avoid concurrent edits to the same file.

Private attachments currently accept TXT and PNG copies only (default limits: 5 MiB/file, 4 files/message, 20 MP/image; configurable in Settings and validated server-side). PDF/Office uploads, attachment forwarding, and general storage management are not supported.

Result download links only serve regular files inside the active workspace, rejecting out-of-bounds paths, escaping symlinks, and framework internals. Archiving preserves records and sent attachments; discarding unsent copies does not delete already-sent content.

## Sessions, Failures, and Recovery

Agent Team cannot take over an already-running host session started in another terminal. It creates sessions and resumes by host ID; panel event views reflect adapter-observed output rather than the host's complete native transcript.

Claude/DSH print/headless modes do not yet have verified durable enqueue receipts, so inputs are confirmed conservatively after a successful turn returns—a crash window may re-send the same directive key. Normal send failures never auto-retry; `unknown` runtimes block subsequent delivery until verified stopped by the user, with no auto-replay.

Closing the browser leaves background turns running; stopping the service preserves teams. Private history separates the current boot from earlier runs. Program binaries and data stay separate without downgrade guarantees—stop the service and back up the full data directory before upgrading.

## Interpreting Results

Multiple agents can cross-check and supplement each other, but consensus is not a guarantee of correctness. Task boards, member profiles, delivery statuses, and message quotes each represent different facts and never replace hands-on verification. Require concrete file paths, evidence, verification methods, and open issues before archiving a team.
