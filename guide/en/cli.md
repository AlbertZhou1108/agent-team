# CLI Reference

[Back to README](../../README.en.md) · [简体中文](../cli.md) · [Development](development.md) · [Architecture](architecture.md)

End users can start with the [release packages and web/desktop UI](quick-start.md). This page is for users launching from a terminal, composing mixed-host teams, or querying team state.

## External Controller Connection

The headless control plane attaches over a stable stdio MCP shim. Register once with `connect`; day-to-day collaboration does not require opening the Agent Team UI:

```bash
npm start -- connect --data /your/framework-data-dir \
  --host codex --client codex-main --principal local-user \
  --workspace /allowed/project-root
```

This command installs or checks the Skill per [definitions.mjs](../../src/hosts/definitions.mjs): Codex, Claude Code, and WorkBuddy use copied skill directories, while DSH and ZCode use the shared `~/.agents/skills/agent-team` entry. The output includes the principal, binding, effective capabilities, Skill content hash, and a ready-to-paste `mcp.agent_team` config. Re-running with the same `--principal` and `--client` rotates credentials and backs up the previous skill directory to `.backup-*`. Unknown hosts can pass `--skill-root` or `--no-install-skill`.

`--workspace` sets the root directory under which teams may be created. Connections allow `communication` / `read-only` / `workspace-write` by default, though each `team_create` call must still pick a policy explicitly. External controllers cannot select workspaces outside that root.

External host Skills should call `control_protocol` at session start and `control_inbox` to claim member replies or decision requests. The MCP shim auto-binds Codex sessions only when the thread identity is unambiguous: top-level sessions have matching `CODEX_THREAD_ID` and `CODEX_SESSION_ID`, whereas Codex multi-agent child sessions differ and stay pull-only. Outer launchers can still call credentialed `bind_client_session` on `thread.started`; `AGENT_TEAM_HOST_SESSION` declares a resumable session explicitly, and `AGENT_TEAM_DISABLE_ACTIVE_WAKE=1` disables auto-binding and clears prior sessions. Codex, DSH, and ZCode register active wake drivers; Claude Code and WorkBuddy currently rely on persistent inbox polling.

When the control protocol version is incompatible, MCP exposes status and read-only tools only; write tools fail explicitly and ask the user to update the Skill and reconnect.

## Starting & Connecting

Run these commands from the repository root after installing dependencies (`npm start` builds the frontend first). Replace example paths with your own directories:

```bash
# Start the standalone daemon
npm start -- serve --data /your/framework-data-dir

# Create a team on that daemon
npm start -- new --name design-review \
  --workspace /your/project-dir \
  --lead codex --members planner=claude,reviewer=dsh \
  --policy workspace-write --data /your/framework-data-dir

# Open interactive chat with a team
npm start -- chat --group <team-id> --data /your/framework-data-dir

# Single-shot private message
npm start -- chat --group <team-id> --text 'Read team history and summarize' --data /your/framework-data-dir
```

You can also run `npm start -- --lead codex --members helper=dsh --workspace /your/project-dir` to start the service, create a team, and enter interactive chat in one terminal (exiting stops that foreground service; standalone `serve` manages its own lifecycle).

`--charter <file>` loads an optional plain-text charter injected into every turn (context only—grants no permissions). `--hosts <file>` supplies host aliases and commands (see [Host Adapters](host-adapters.md)). The dev CLI defaults `--data` to `work/local`, separate from the user launcher's OS application data directory.

## Interactive Chat Commands

| Command | Purpose |
| --- | --- |
| `/members` | List members, hosts, and self-profiles |
| `/state` | Inspect coordination state and turns awaiting verification |
| `/direct <text>` | Send an explicit shared user directive to the team coordination session |
| `/resolve <runId> <reason>` | Mark an `unknown` runtime stopped after verifying on disk/process |
| `/archive`, `/restore` | Archive or restore the team |
| `/add <name>=<host>` | Add a new member role and session (names stay unique in team history) |
| `/remove <name>` | Permanently remove a role, revoke access, and stop its session |
| `/stop <name>` | Best-effort interrupt of a member's active turn |
| `/retry` | Manually retry an undelivered input with the same directive key |
| `/groups`, `/use <teamId>` | List teams or switch the active team |
| `/delete` | Confirm and delete team config/history (keeps workspace files and host history) |
| `/quit` | Exit the interactive CLI |

Plain chat inputs and `/direct` have different visibility scopes. Do not assume private chat messages were shared with the team, and do not treat a message ID as proof that work succeeded.

## User Launcher

```bash
npm run launch -- --data /isolated/data-dir
npm run launch -- --data /isolated/data-dir --status
npm run launch -- --data /isolated/data-dir --stop
```

`--no-open` starts the service without launching a browser; `--hosts` specifies a host config file. The launcher probes IPC first to reuse running instances rather than relying blindly on stale URLs or PID files.

Model catalog query: `npm start -- models --data /your/framework-data-dir`. Probes do not verify live model inference or account quota.
