# Headless Control Plane

[Back to README](../../README.en.md) · [简体中文](../headless-control-plane.md) · [Architecture](architecture.md) · [Host Adapters](host-adapters.md)

This document specifies Agent Team's collaboration control plane for external hosts. Any "target" descriptions do not imply already-shipped features; current source and tests are authoritative.

## Current Implementation Status

Implemented:

- External principals, revocable client bindings, and capability-intersection checks.
- Fixed stdio MCP shim and explicit `teamId` parameters on cross-team tools.
- External controllers creating teams, reading snapshots/members/history, sending messages/notes, updating tasks, stopping members, and archiving teams.
- Member replies queued in a persistent external inbox; `control_inbox` claims them without duplicate delivery.
- Top-level Codex sessions auto-bind when `CODEX_THREAD_ID` matches `CODEX_SESSION_ID`, or via `bind_client_session` called from an outer launcher on `thread.started`. Codex multi-agent child sessions differ and degrade to pull-only; `AGENT_TEAM_HOST_SESSION` declares a resumable session explicitly, and `AGENT_TEAM_DISABLE_ACTIVE_WAKE=1` disables auto-binding and clears stale sessions. The MCP shim stores reconstructable wake config to re-inject Agent Team MCP via `codex exec resume` when deliveries backlog (`control_inbox` is still required after wake).
- Member `ask` calls in headless teams become pending decision requests; controller answers wake the requesting member as user-origin messages.
- Codex active wake uses `app-server`'s `thread/queue/add`, marking the client binding ready only after observing a real `turn/started`.
- ZCode active wake uses ZCode Protocol (`zcode.cjs app-server --stdio`) `session/resume` + `session/send`, awaiting real `turn.started`/`turn.completed`. Because ZCode MCP subprocesses do not receive a session ID env var, controller sessions bind inside the session via `agent-team connect --host zcode --session "$ZCODE_SESSION_ID"`. Headless protocol sessions auto-approve allow-style permission prompts while tool boundaries remain enforced by team policy; `AGENT_TEAM_ZCODE_HOME` redirects ZCode data for isolated host verification.
- DSH active wake needs no daemon: headless `--session-id` resumes persisted sessions (requiring an exact matching `cwd`), runs one process per wake, and injects the `agent_team` MCP server via wake overlay. Controller sessions bind inside the team workspace via `agent-team connect --host dsh --session "$DSH_SESSION_ID"`. DSH clears `DSH_*` vars in MCP subprocesses and disables the credential service in one-shot headless turns, so API keys must come from the launch environment; skills use the shared `~/.agents/skills` entry (`~/.dsh/skills/agent-team` is reserved by DSH's built-in plugin).
- New headless teams start in provisioning and reject work dispatch until active wake is verified (or the user explicitly accepts binding-level pull-only).
- Headless member models can be specified structurally in `team_create` or adjusted via `team_member_model`, both validated against the live catalog.
- Team policy caps member capabilities (`team_send.requiredCapabilities` rejects mismatched dispatches before writing messages).
- Bindings, pending deliveries, and decisions survive service restarts.
- Incompatible control protocol versions expose read-only tools only, failing write operations cleanly.
- `connect` installs/updates Skills for known hosts, rotates credentials on re-registration, and backs up prior skill folders.
- Live host verification milestones: Codex <-> Claude Code (2026-11-08), ZCode dual-role verification (2026-11-17, re-verified 2026-11-18 across updated ZCode.app layout), and DSH dual-role verification (2026-11-17).

Not yet implemented:

- Active wake drivers for all hosts: Codex, ZCode, and DSH register active wake; Claude Code and WorkBuddy remain persistent pull-only until native injection is implemented.
- Multi-controller handoff, remote connections, and full native TUI embedding.

## Product Boundaries

Agent Team is a host-agnostic, headless-first multi-agent collaboration control plane:

- External hosts integrate via MCP and the Agent Team Skill without requiring the first-party client (`agent-team connect` registers bindings and prints stdio MCP config).
- First-party clients and external hosts are parallel entry points; core control capabilities must never exist only inside the UI client.
- Panel Agent is an optional global assistant for the first-party client—not part of the headless core and not an abstraction for external controllers.
- Codex, Claude Code, DSH, and ZCode are member adapter implementations; WorkBuddy is a controller-only MCP registration. Product semantics must not depend on any single host.

## Roles

| Role | Meaning |
| --- | --- |
| User | Owner of Agent Team data and sole authority for irreversible actions like permanent deletion |
| External controller | A long-lived host-managed session coordinating teams |
| Managed member | A host member spawned, woken, and tracked per turn by Agent Team |
| External participant | A host able to exchange messages via bridge without active session injection |
| Observer | A role with read-only access to authorized teams |

Products, host sessions, and team roles are independent concepts: opening a new window in the same host app never automatically makes it an existing member, controller, or observer.

## Identity & Control Ownership

- One Agent Team user identity can connect multiple host sessions.
- One external controller session can manage multiple teams.
- Each team has at most one active controller session at a time.
- One principal can register multiple client bindings; non-active bindings may observe, while writes require calling `team_activate` to claim the active seat.
- A new session can resume an existing team, revoking write access from the previous session.
- Removing a client binding revokes access without deleting teams or auto-transferring control.
- Every team tool takes `teamId` explicitly—never an implicit "current team".

## Controller Capabilities

A host qualifies as an External controller only if it supports:

1. Stable session identity.
2. Delivering new messages to an existing session (starting a turn when idle, queueing when busy).
3. Observing runtime status and turn terminal states.
4. Reporting failures, cancellations, and unavailability.

Hosts that can only invoke MCP tools without receiving injected turns cannot act as controllers (though they may participate externally).

Adapters must declare theoretical capabilities and measure them at connection time; the effective toolset is their intersection—never guessed by host name.

## Permission Ceiling

Effective team and member permissions never exceed:

```text
Controller host permissions
∩ Team workspace scope
∩ Team policy
∩ Managed member host capabilities
```

Within its host permission scope, an External controller is trusted to create teams, choose policies, and delegate work without second-guessing confirmations outside the model. Exceeding permissions must fail explicitly rather than silently downgrading or escalating privileges. Permanent deletion is restricted to user CLI or first-party UI; External controllers may archive teams.

## Delivery

- `send` wakes recipients automatically (starting idle turns or queueing busy ones); `note` batches onto the next formal input.
- When the controller is offline, replies queue persistently while members finish safely without spawning replacement controllers.
- Async control events reuse `deliver(envelope)`; native host notifications are optional enhancements.
- Wake and claim are distinct: `queued/started` means the host accepted the wake, whereas `control_inbox` claim marks client acceptance.
- Synchronous tool errors return via MCP `isError`; only unattached async errors push as control events.

## User Interaction

The headless control plane defines two interaction primitives:

- `notice`: informational only, no reply expected.
- `decision_request`: requires user choice, input, or confirmation and returns a structured `decision_answer` back to the requesting member. Decision requests belong to the team rather than a single host session so a new controller can answer them.

First-party UIs render decision requests as interaction cards, though cards are not the underlying protocol.

## Data & Privacy

- Agent Team records are the authoritative source of collaboration facts.
- Host-native transcripts are the controller's own local copy and may contain only injected inputs and partial events.
- Agent Team never scrapes an External controller's full host chat history; controllers submit briefs explicitly, and raw user text is stored only if supplied by the controller.
- Managed member raw host sessions expose no supported external resume entry point; bypassing the framework to resume them directly is unsupported and handled as `unknown/failed`.

## Skills & Protocol Versioning

- Skills ship a thin startup entry plus an MCP runtime guide, versioned with protocol range and content hash (`connect` installs/updates them and backs up prior copies).
- Running sessions with older Skills are not hot-reloaded.
- Protocol version mismatches allow read-only queries and reject semantic writes while distinguishing stale Skills, incompatible MCP, and insufficient host capabilities.

## Connection & Network Boundaries

- Strictly local connections only: Unix socket, Windows named pipe, or loopback HTTP.
- Every host uses a stdio MCP shim to reach the local daemon with per-binding revocable credentials.
- LAN, remote, and cloud transports remain out of scope for the current phase.

## Current Open Boundaries (2026-11-19)

- Control protocol version `1`; persisted schema version `18` in the `headless` baseline (current source schema is `22`). Step-by-step upgrades preserve data; older binaries cannot open newer schemas.
- Contract tests cover external controllers, deliveries, decisions, capability intersections, workspace boundaries, protocol degradation, dual-binding single-writer seats, and archive pause (with the first five also verified on real Codex/Claude/DSH/ZCode/MCP environments).
- Active wake has live evidence on Codex, DSH, and ZCode; Codex multi-agent child sessions, Claude Code, and WorkBuddy stay pull-only.
- Codex active wake turns use a `read-only` sandbox; ZCode and DSH follow their own session/headless permission paths without bypassing team policy or host sandboxes.
- Strictly local only; remote deployment, concurrent multi-controller writes, full native TUI embedding, and Panel Agent / External controller parity remain out of scope.
