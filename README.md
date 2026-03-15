<p align="center">
  <img src="build/logo-text-squared.svg" alt="Parallel Code" height="76">
</p>

<p align="center">
  Run multiple AI coding agents without the chaos.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/Browser-4285F4?logo=googlechrome&logoColor=white" alt="Browser">
  <img src="https://img.shields.io/badge/SolidJS-2C4F7C?logo=solid&logoColor=white" alt="SolidJS">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20WSL2-lightgrey" alt="macOS | Linux | WSL2">
  <img src="https://img.shields.io/github/license/johannesjo/parallel-code" alt="License">
</p>

<p align="center">
  <img src="screens/longer-video.gif" alt="Parallel Code demo" width="800">
</p>

**Parallel Code** gives Claude Code, Codex CLI, and Gemini CLI each their own git branch and worktree — automatically. No agents stepping on each other's code, no juggling terminals, no mental overhead. Just one clean interface where you can see everything, navigate fast, merge results when they're ready — and monitor it all from your phone.

## Screenshots

| Agent working on a task                     | Commit & merge workflow           |
| ------------------------------------------- | --------------------------------- |
| ![Agent working](screens/agent-working.png) | ![Workflow](screens/workflow.png) |
| **Direct mode (main branch)**               | **Themes**                        |
| ![Direct mode](screens/direct-mode.png)     | ![Themes](screens/themes.png)     |

## Why Parallel Code?

Running multiple AI coding agents is powerful — but chaotic. On the same branch, agents interfere with each other's code. Across terminals, you lose track of what's happening where. Setting up feature branches and worktrees manually works, but adds cognitive load you shouldn't have to deal with.

| Approach                                           | What's missing                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Multiple terminal windows / tmux**               | No GUI, no automatic git isolation — you manage worktrees, branches, and merges by hand |
| **VS Code extensions** (Kilo Code, Roo Code, etc.) | Tied to VS Code; no true parallel worktree isolation between agents                     |
| **Running agents sequentially**                    | One task at a time — blocks your workflow while each agent finishes                     |

Parallel Code combines a dedicated GUI, automatic worktree isolation, and multi-agent orchestration into one app — so you can dispatch five tasks and walk away.

## How Parallel Code Solves It

When you create a task, Parallel Code:

1. Creates a new git branch from your main branch
2. Sets up a [git worktree](https://git-scm.com/docs/git-worktree) so the agent works in a separate directory
3. Symlinks `node_modules` and other gitignored directories into the worktree
4. Spawns the AI agent in that worktree

This means you can have five agents working on five different features at the same time, all from the same repo, with zero conflicts. When you're happy with the result, merge the branch back to main from the sidebar.

## Features

### One interface, every AI coding agent

Use [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), and [Gemini CLI](https://github.com/google-gemini/gemini-cli) from the same interface. Switch between agents per task, or run all three at once — no juggling terminal windows.

### 5 agents, 5 features, zero conflicts

Every task gets its own git branch and [worktree](https://git-scm.com/docs/git-worktree) instantly. Agents work in full isolation — no conflicts, no stashing, no waiting. Five agents, five features, one repo. Merge back to main when you're done.

### Walk away — monitor from your phone

Scan a QR code and watch all your agent terminals live on your phone — over Wi-Fi, Tailscale, or any network. The mobile companion is a full PWA with native terminal interaction, quick-action buttons, swipe gestures, and haptic feedback. Install it to your home screen for instant access.

### Browser mode — no Electron required

Run Parallel Code as a standalone Node.js server accessible from any browser. Deploy it on a remote VM, a headless server, or WSL2 — and access the full UI from `http://your-server:3000`. The remote mobile app is available at `/remote`.

### Task-scoped preview — expose app ports safely

If a task starts a dev server, Parallel Code can now track detected localhost ports, let you explicitly expose the ones you trust, and open them in an embedded preview. In browser mode, exposed ports are proxied through authenticated task-scoped preview URLs instead of blindly forwarding arbitrary localhost services.

### Inline task attention — know which task needs you next

Parallel Code now treats task supervision as backend-owned state. If an agent is waiting for input, idle at a prompt, failed, paused, flow-controlled, restoring, or simply gone quiet too long, that state shows up directly on the task rows in the sidebar instead of depending on a mounted terminal.

### Inline review signals — know what is ready to merge next

Parallel Code now derives a convergence model from branch diffs, merge status, and worktree status. The sidebar task rows show compact review signals for tasks that are ready to review, need refresh because main moved ahead, or have blocking uncommitted changes so you can converge parallel work with less guesswork.

### Keyboard-first, mouse-optional

Navigate panels, create tasks, send prompts, merge branches, push to remote — all without touching the mouse. Every action has a shortcut, and `Ctrl+/` shows them all.

### And more

- Tiled panel layout with drag-to-reorder
- Built-in diff viewer and changed files list per task
- Shell terminals per task, scoped to the worktree
- Direct mode for working on the main branch without isolation
- Six themes — Minimal, Graphite, Classic, Indigo, Ember, Glacier
- State persists across restarts
- macOS, Linux, and WSL2

## Getting Started

**Prerequisites:** [Node.js](https://nodejs.org/) v18+ and at least one AI coding CLI — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google-gemini/gemini-cli).

### Option 1: Desktop App (Electron)

Download the latest release from the [releases page](https://github.com/johannesjo/parallel-code/releases/latest):

- **macOS** — `.dmg` (universal)
- **Linux** — `.AppImage` or `.deb`

Open Parallel Code, point it at a git repo, and start dispatching tasks.

### Option 2: Browser Mode (Standalone Server)

Run without Electron — deploy on any machine with Node.js:

```sh
git clone https://github.com/johannesjo/parallel-code.git
cd parallel-code
npm install
npm run server        # builds everything, starts on port 3000
```

Open the URL printed in the terminal (includes a one-time auth token). Set `AUTH_TOKEN` for a persistent token, or copy `.env.example` to `.env` to configure all options:

```sh
AUTH_TOKEN=my-secret-token npm run server
```

The mobile-optimized remote app is available at `/remote` — installable as a PWA on your phone.

For active browser UI development, use watch mode instead of `npm run server`:

```sh
npm run browser:dev
```

`npm run server` is a production-style build-and-serve path. `npm run browser:dev` watches the frontend, remote app, and server output and restarts the Node server automatically as files change.

<details>
<summary><strong>All commands</strong></summary>

| Command                | Description                                   |
| ---------------------- | --------------------------------------------- |
| `npm run browser:dev`  | Browser-mode dev server with auto rebuild     |
| `npm run dev`          | Start Electron app in dev mode                |
| `npm run server`       | Build and start standalone server (port 3000) |
| `npm run dev:server`   | Server dev mode with hot reload               |
| `npm run build`        | Build production Electron app                 |
| `npm run build:remote` | Build remote mobile app to `dist-remote/`     |
| `npm run typecheck`    | Run TypeScript type checking                  |
| `npm test`             | Run the full node + Solid test suites         |
| `npm run test:node`    | Run node/transport/backend tests              |
| `npm run test:solid`   | Run Solid/jsdom screen behavior tests         |

</details>

<details>
<summary><strong>Keyboard Shortcuts</strong></summary>

`Ctrl` = `Cmd` on macOS.

| Shortcut              | Action                         |
| --------------------- | ------------------------------ |
| **Tasks**             |                                |
| `Ctrl+N`              | New task                       |
| `Ctrl+Shift+A`        | New task (alternative)         |
| `Ctrl+Enter`          | Send prompt                    |
| `Ctrl+Shift+M`        | Merge task to main             |
| `Ctrl+Shift+P`        | Push to remote                 |
| `Ctrl+W`              | Close focused terminal session |
| `Ctrl+Shift+W`        | Close active task              |
| **Navigation**        |                                |
| `Alt+Arrows`          | Navigate between panels        |
| `Ctrl+Alt+Left/Right` | Reorder active task            |
| `Ctrl+B`              | Toggle sidebar                 |
| **Terminals**         |                                |
| `Ctrl+Shift+T`        | New shell terminal             |
| `Ctrl+Shift+D`        | New standalone terminal        |
| **App**               |                                |
| `Ctrl+,`              | Open settings                  |
| `Ctrl+/` or `F1`      | Show all shortcuts             |
| `Ctrl+0`              | Reset zoom                     |
| `Ctrl+Scroll`         | Adjust zoom                    |
| `Escape`              | Close dialog                   |

</details>

## Remote Mobile App

The `/remote` route serves a dedicated mobile-optimized terminal interface:

- **Full terminal interaction** — native keyboard input, not just monitoring
- **Quick-action button bar** — grouped by category (Keys, Navigation, Signals) with long-press repeat on arrow keys
- **Swipe gestures** — swipe from the left edge to go back to the agent list
- **Agent management** — kill running agents with confirmation dialog
- **Terminal controls** — adjustable font size (A+/A-) with toast indicator, scroll-to-bottom FAB
- **PWA installable** — add to home screen for app-like experience
- **Accessibility** — full ARIA labels, reduced-motion support, focus-visible indicators
- **Resilient connection** — ping/pong heartbeat, auto-reconnect with status banners, loading skeletons
- **Haptic feedback** — vibration on button presses for tactile response

## Architecture

Start here if you are changing core behavior or reviewing a refactor:

- [docs/ARCHITECTURAL-PRINCIPLES.md](docs/ARCHITECTURAL-PRINCIPLES.md)
- [docs/UPSTREAM-DIVERGENCE.md](docs/UPSTREAM-DIVERGENCE.md)
- [docs/REVIEW-RULES.md](docs/REVIEW-RULES.md)

These docs define the repo's architecture rules, layer ownership, upstream-port workflow, and review guardrails.
If you are syncing work from upstream, use the divergence playbook as the primary porting checklist and current upstream sync-status reference.
If you are reviewing a non-trivial change, use the review-rules doc as the practical checklist for runtime, preview, and suite-stability pitfalls.
For non-trivial upstream ports, also follow the repo-level [AGENTS.md](AGENTS.md) workflow: classify first, map to the local owner, then validate at the correct seam.

For the current runtime walkthrough and testing strategy, see:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/TESTING.md](docs/TESTING.md)

Parallel Code runs in two modes:

### Electron Mode (Desktop)

The traditional desktop app with native window management, system tray, and file dialogs. Frontend communicates with the backend via Electron IPC.

### Server Mode (Browser)

A standalone Express server bootstrapped from `server/main.ts` and composed in `server/browser-server.ts` serves the desktop frontend at `/` and the remote mobile app at `/remote`. WebSocket handles real-time terminal I/O. The browser frontend uses the same SolidJS codebase with an HTTP/WebSocket IPC transport layer (`src/lib/ipc.ts`) that replaces Electron IPC.

```
┌──────────────────────────────────────────┐
│           Node.js Server                 │
│                                          │
│  ┌──────────┐   ┌──────────────────────┐│
│  │ PTY Pool │◄─►│ Browser Server Shell ││
│  │ (pty.ts) │   │ (browser-server.ts)  ││
│  └────┬─────┘   └──────┬─────────────┘  │
│       │                │                 │
│       ▼                ├── /     Desktop UI (SolidJS)
│  Ring Buffer           ├── /remote  Mobile UI (SolidJS)
│  (scrollback)          ├── /ws    WebSocket (I/O + control)
│                        └── /_preview/:taskId/:port/*  Authenticated preview proxy
└──────────────────────────────────────────┘
```

### Performance Optimizations

- **Binary WebSocket frames** for terminal output — 25% bandwidth reduction vs base64
- **WebGL context pooling** — LRU pool of 6 contexts prevents context loss flicker
- **Flow control via WebSocket** — pause/resume through the socket, not HTTP POST
- **Optimized output scheduling** — synchronous fast path for small chunks, RAF batching for large output
- **Terminal latency measurement** — built-in RTT probes and throughput benchmarks

### Reliability

- **Hundreds of automated tests** across the node and Solid suites
- **Attention inbox and backend supervision** — prompt-aware task attention driven by pushed backend state, not mounted-terminal polling
- **Bundled Hydra resolution** — runtime asset lookup works across Electron and standalone browser/server layouts
- **Task-scoped preview proxy** — detected localhost ports can be explicitly exposed and replayed to browser clients, then opened through authenticated preview routes
- **Review queue and convergence projection** — merge readiness, overlap warnings, and post-merge sibling refreshes are derived from canonical git data instead of being guessed in the UI
- **Unified bootstrap and replay registry** — Electron startup hydration and browser replay now restore the same server-owned state categories through one shared registry instead of hand-maintained startup wiring
- **Coordinator guardrails** — startup/session sync, browser replay, review surfaces, and task presentation now have architecture tests that lock in ownership boundaries
- **Split test architecture**:
  - node suite for transport, workflows, IPC, PTY, latency, browser server, and contract coverage
  - Solid/jsdom suite for high-churn screen behavior, review flows, and startup-facing UI flows
- **Broadcast crash protection** — try/catch around WebSocket sends to disconnecting clients
- **Connection limiting** — post-authentication to prevent pre-auth DoS
- **Abandoned channel GC** — 30-second TTL on channels with no listeners
- **Ping/pong heartbeat** — 30s ping interval, 10s pong timeout for stale connection detection

---

If Parallel Code saves you time, consider giving it a [star on GitHub](https://github.com/johannesjo/parallel-code). It helps others find the project.

## License

MIT
