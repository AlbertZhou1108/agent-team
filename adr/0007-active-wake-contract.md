# Active wake is a verifiable capability for Codex controllers

Status: accepted

## Context

Headless teams lose an important collaboration guarantee when an idle external controller cannot be woken. A Codex binding may have a valid session yet fail to resume because its custom model provider is absent from the wake process configuration. Treating configuration presence as proof of active wake therefore produces false capability claims and leaves replies waiting in the persistent inbox.

## Decision

Active wake is a release gate for controllers whose host adapter implements a resumable wake driver. The binding does not gain Verified active wake until a real wake reaches `started`. The core contract is host-neutral: each adapter owns capability probing, its wake driver, and the Wake environment fingerprint. The first implementation targets Codex app-server `thread/queue/add`; an idle thread starts immediately, so the driver waits for `turn/started` instead of issuing a second start after the queue has already been consumed. Other hosts remain Pull-only until their adapters implement the contract.

Wake state and delivery state are separate. Active wake progresses through `queued`, `started`, `failed`, or `unsupported`; `claimed` belongs to External delivery. At most one wake may run for a binding/session, nearby events are batched, and failures retry with bounded backoff before the binding degrades to Pull-only.

Hosts that cannot inject into an existing session may remain Pull-only, but the degradation must be visible. A wake failure never causes message loss. Pull-only acceptance belongs to the Client binding and applies to its existing and future teams until its wake environment changes or the user retries verification.

A team created before wake verification is provisioning. Snapshot reads, member reads, configuration, and decision answers remain available, but work dispatch is rejected with a structured `headless_not_ready` error until the binding is ready or the user explicitly accepts Pull-only for that binding. Losing wake readiness later restores the same gate for new work without deleting the team.

Pull-only acceptance is an idempotent, auditable binding-level action. It applies to all existing and future teams for that binding and can be followed by another wake verification; a successful retest clears degraded readiness.

## Considered options

- Always remain Pull-only: safe but fails the required headless collaboration guarantee.
- Load the controller's complete user configuration into `exec resume`: likely resumes custom providers, but also changes the wake turn's plugins, hooks, and MCP boundaries.
- Reconstruct provider configuration for every wake: supports older Codex versions, but requires careful secret handling and is a fallback rather than the primary path.

## Consequences

Connection or onboarding must expose an explicit wake test, which may consume model quota and appears as a clearly marked technical prompt in the real controller session. The framework needs adapter-owned wake fingerprints, durable wake attempts, retry scheduling, structured host events, and a capability state that can be demoted without affecting delivery.

Control protocol v1 remains compatible through additive fields and dynamically listed tools. Old clients continue to work through control reads and Pull-only delivery; they do not need a protocol-version break merely to coexist with active wake.
