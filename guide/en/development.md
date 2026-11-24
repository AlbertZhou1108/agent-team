# Development, Testing & Release Packaging

[Back to README](../../README.en.md) · [简体中文](../development.md) · [Architecture](architecture.md) · [Design Baseline](../../docs/DESIGN.md)

## Environment & Running from Source

Requires Node.js >=22.13.0, npm, and whichever host CLI or desktop app you plan to use. SQLite is provided by Node (`node:sqlite`), requiring no external database. Clone the repo and run from the root:

```bash
npm ci
npm run dev
```

Dev API listens on `127.0.0.1:62048` and Vite serves on `http://127.0.0.1:5173/`, using `work/dev` as dev data. Production mode uses `npm start -- serve --data /isolated/data-dir` (`prestart` builds the frontend). See [CLI Reference](cli.md) for terminal usage.

### Desktop Window (Development)

```bash
npm run desktop          # Build frontend, then open desktop window
npm run desktop:quick    # Skip build when web/dist is already up to date
npm run desktop:dev      # Start/reuse API + Vite, then open window (live reload)
npm run dev              # Browser-only dev servers
```

`desktop:dev` probes `127.0.0.1:62048` and `5173`, reusing whichever is already running and spawning only missing ones, cleaning up only processes it started on exit. Override the dev data folder with `AGENT_TEAM_DEV_DATA`.

The Electron shell wraps the same architecture: the backend stays an independent process managed by `src/launcher.mjs`, the window calls `loadURL(instance.url)`, and data uses `applicationData()`. Closing the window hides it to the tray while keeping the service running. Release installers do not use code signing or auto-update by project design.

The desktop shell adds native folder picking, app menu/shortcuts, window geometry persistence, and Dock/tray pending badges (unanswered interaction cards + unread messages; 5s badge poll, 15s service liveness check).

First run downloads the Electron binary (`npm ci` does not). Restricted containers without Chromium sandbox support can append `--no-sandbox` for local dev only. All Node child scripts under Electron must launch via `nodeRunner()` in `src/runtime.mjs` so `ELECTRON_RUN_AS_NODE=1` is passed rather than invoking `process.execPath` directly.

Native desktop capabilities follow **progressive enhancement**: preload injects helpers optionally (`web/src/env.d.ts`), and frontend callers write `globalThis.agentTeam?.xxx?.()` with HTTP fallbacks (e.g., native dialog vs `/api/local/directory-picker`) so browser mode always works.

## Directory Layout

| Location | Contents |
| --- | --- |
| `src/` | Node ESM backend, core bus facade, and services |
| `src/hosts/` & `src/host-runtime/` | Host declarations, registries, policies, static capabilities, and install/probe/wake helpers |
| `src/member/` | Per-host member adapters (`codex/`, `claude/`, `dsh/`, `zcode/`), zero cross-imports |
| `src/aggregates/` | Core write boundaries and invariants (8 modules guarding `messages`, `turns`, `conversations`, etc.) |
| `web/` | Vue 3, TypeScript, Vite frontend (npm workspace) |
| `electron/` | Desktop shell: launcher, main process, tray, preload |
| `src/tests/` | `node:test` backend suites (`core/` logic & contracts + `smoke/` process smoke, plus `support/` fixtures) |
| `web/tests/` | Vitest pure-logic frontend tests mirroring `web/src/` |
| `scripts/` | Verification gates, release packager, and manual live-host scripts |
| `guide/` | User and technical documentation (`guide/en/` for English) |
| `assets/readme/` & `assets/architecture/` | README screenshots/illustrations and exported architecture diagrams |
| `work/` | Local runtime data (gitignored; never wipe user data) |
| `docs/` | Documentation directory: gitignored by default for local working notes and process artifacts; tracked exceptions (e.g. `docs/adr/`, `docs/DESIGN.md`) are explicitly allowlisted in `.gitignore` |

## Verification Gates

```bash
npm run check:docs     # Docs-only: local markdown link checks
npm run check:web      # Frontend: design governance + web boundary + vue-tsc + lint:web
npm run check:backend  # Backend/electron: syntax/imports + tsc + lint:backend
npm run check          # Full static checks (also run in CI)
npm test               # Full automated test suite (run targeted files locally; CI runs full suite)
npm run build
```

`check` runs syntax/import/doc-link checks, design governance (`check-design.mjs`), pure-Web layering checks (`check-layering.mjs`), version consistency, dual typechecks, and dual ESLint. CI runs `check`, `build`, and `test` on Ubuntu, macOS, and Windows plus macOS `desktop-smoke`; keep tests platform-neutral and stub host CLIs instead of calling live models.

Manual live-host verification (consumes real host auth and quota):

```bash
node --disable-warning=ExperimentalWarning scripts/verify-collaboration.mjs
```

Frontend UI follows [docs/DESIGN.md](../../docs/DESIGN.md), with `web/` as the `shadcn-vue` workspace root.

## Release Packaging

Run on the target OS into a fresh output directory:

```bash
npm ci
npm run package -- /absolute/path/to/new-dist-dir
```

Packages bundle Node, licenses, backend dependencies, and built frontend assets with SHA-256 manifests (`Agent Team.app` on macOS, `.cmd` on Windows, `.sh` on Linux; the macOS `.app` is a launcher without a bundled WebView). Cross-compilation is not supported.

### Automated Release Builds (No Auto-Publish)

`.github/workflows/release.yml` builds three-platform archives and SHA-256 checksums on `v*` tag pushes or manual dispatch without publishing a GitHub Release unattended:

- The tag must match `package.json` `version` (`vX.Y.Z`).
- After verifying the Actions run Artifacts and `.sha256` checksums, upload them manually to a GitHub Release or have the agent run `gh release create` **only after explicit user confirmation**.
- Signing, installation, and live-OS acceptance remain manual steps before public distribution.

## Skill Maintenance & Sync

`skills/agent-team/` is the canonical source for the `agent-team` Skill (kept in sync with tools, permissions, routing, and `references/`). Prefer linking shared local skill directories back to this canonical source, backing up independent copies before migrating, and starting a fresh session for hosts to pick up Skill updates.
