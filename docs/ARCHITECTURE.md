# Architecture Walkthrough

This document explains the current architecture of Parallel Code as it exists after the recent transport and simplification work.

It is intentionally not a design manifesto. It is a map of:

1. what the system is
2. how data actually flows today
3. which layers are reasonably clean
4. where the architecture is still mixed or awkward

Use this as the reference point for future refactors and for evaluating deltas against architectural goals.

## Scope

This walkthrough covers:

- the desktop UI shared by Electron mode and browser mode
- the remote/mobile UI
- the shared websocket transport
- the Electron IPC backend
- the standalone browser server shell
- the main domain concepts: projects, tasks, agents, terminals, channels, and control events

Key files:

- `src/App.tsx`
- `src/runtime/*`
- `src/lib/ipc.ts`
- `src/lib/websocket-client.ts`
- `src/store/*`
- `electron/ipc/*`
- `electron/remote/*`
- `server/browser-server.ts`
- `server/main.ts`

## Mental Model

Parallel Code is best understood as one application with three runtime shells around a shared agent/task core:

1. Electron desktop shell
2. Browser desktop shell
3. Remote/mobile shell

All three shells ultimately operate on the same underlying concepts:

- a `Project` is a repo/worktree root plus defaults
- a `Task` is the user-facing unit of work
- an `Agent` is the long-lived PTY-backed worker attached to a task
- `AgentSupervision` is the backend-owned supervision snapshot used for attention routing
- `TaskConvergence` is the app-level projection used for review readiness, overlap, and convergence queueing
- a `Terminal` is an extra shell panel in the UI, not the same thing as an agent
- a `Channel` is a transport output stream binding used primarily in browser mode
- a `ServerMessage` / `ClientMessage` pair is the websocket control vocabulary

The architecture is not fully layered in a classic clean-architecture sense. The current direction is more pragmatic:

- shared protocol and transport primitives
- explicit runtime adapters for Electron, browser desktop, and remote/mobile
- explicit workflow modules for multi-step use cases
- store and UI layers that are moving toward projection and presentation
- thin server shells that should compose, not own, the workflow logic

That matters because most of the recent quality work has not been about inventing a new architecture. It has been about making the real seams explicit:

- browser mode now has three explicit transport planes
- backend multi-step operations now have named workflow modules
- server-owned state like browser git status now prefers push and replay over client polling
- supervision and attention state are backend-owned and pushed to clients
- lifecycle-heavy transport code is now typed and tested more aggressively

## High-Level Layers

### 1. UI Shell Layer

Files:

- `src/App.tsx`
- `src/components/*`
- `src/remote/App.tsx`
- `src/remote/AgentList.tsx`
- `src/remote/AgentDetail.tsx`

Responsibilities:

- render the desktop or remote UI
- bind DOM events, keyboard shortcuts, drag/drop, dialogs
- subscribe to store and runtime state
- translate user interaction into workflow or store actions

This layer is much thinner than it used to be. The main remaining UI hotspots are large screens like `TaskPanel.tsx` and some transport-aware surfaces like `TerminalView.tsx`.

### 2. Runtime Adapter Layer

Files:

- `src/app/desktop-session.ts`
- `src/runtime/browser-session.ts`
- `src/runtime/server-sync.ts`
- `src/runtime/window-session.ts`
- `src/runtime/drag-drop.ts`
- `src/runtime/app-shortcuts.ts`
- `src/lib/ipc.ts`
- `src/remote/ws.ts`

Responsibilities:

- adapt the UI to Electron mode vs browser mode vs remote/mobile mode
- coordinate desktop startup and teardown ordering
- manage websocket lifecycle, browser reconnection, connection banners, queueing
- manage window lifecycle in Electron mode
- translate transport events into store updates and workflow refreshes

This is now one of the most important seams in the codebase. Runtime wiring is much easier to find than it was before the refactor passes.

### 3. Shared Transport Layer

Files:

- `src/lib/websocket-client.ts`
- `electron/remote/ws-transport.ts`
- `electron/remote/protocol.ts`
- `src/lib/client-id.ts`

Responsibilities:

- shared websocket client behavior
- shared websocket server behavior
- auth handshake shape
- heartbeat/pong handling
- reconnect + replay cursor behavior
- control-event sequencing
- controller lease behavior

This is the cleanest part of the current architecture. The transport rules are more centralized, better typed, and better tested than they were before.

### 4. Workflow / Use-Case Layer

Files:

- `src/app/task-workflows.ts`
- `src/app/git-status-sync.ts`
- `src/app/task-convergence.ts`
- `src/app/remote-access.ts`
- `electron/ipc/task-workflows.ts`
- `electron/ipc/git-status-workflows.ts`
- `electron/ipc/remote-access-workflows.ts`

Responsibilities:

- own multi-step user-facing operations
- sequence backend mutations plus side effects
- centralize refresh, watcher, and reconciliation behavior
- project backend-owned state like remote access and task attention into UI-facing models
- derive review-ready, stale, and overlap-aware convergence state from canonical git data
- keep transport adapters and handlers thin

This layer is newer than the others, but it is now a real part of the architecture. It is the main answer to the earlier problem where end-to-end behavior was scattered across handlers, services, store slices, and runtime shells.

### 5. Application State / Projection Layer

Files:

- `src/store/core.ts`
- `src/store/store.ts`
- `src/store/tasks.ts`
- `src/store/agents.ts`
- `src/store/taskStatus.ts`
- `src/store/projects.ts`
- `src/store/remote.ts`
- `src/store/persistence.ts`
- `src/store/types.ts`

Responsibilities:

- hold the client-side source of truth for UI state
- expose mutations and selectors
- own persistence loading/saving logic
- derive task/agent status for presentation

This layer is cleaner than it was, but it is still not "just state". Some store modules still act as a workflow facade, especially around task and agent behavior.

One newer app projection worth calling out is task convergence:

- `src/app/task-convergence.ts`

It combines existing backend-owned git signals:

- branch diff
- worktree status
- merge status
- branch log

into a UI-facing convergence model:

- review-ready
- needs-refresh
- merge-blocked
- dirty-uncommitted
- overlap-risk

That projection intentionally lives above raw git services and below the UI so the sidebar review queue, review panel summary, and post-merge sibling refreshes all use one model.

### 6. Backend Service Layer

Files:

- `electron/ipc/pty.ts`
- `electron/ipc/git.ts`
- `electron/ipc/tasks.ts`
- `electron/ipc/storage.ts`
- `electron/ipc/git-watcher.ts`
- `electron/ipc/plans.ts`
- `electron/ipc/agent-status.ts`

Responsibilities:

- spawn and manage PTY sessions
- manipulate worktrees, branches, diffs, and commits
- persist and reload app state
- compute backend-owned projections like canonical agent status

These modules are intentionally low-level. They should provide capabilities that workflows and handlers compose rather than quietly becoming use-case layers themselves.

One newer backend service worth calling out is agent supervision:

- `electron/ipc/agent-supervision.ts`

It derives task-attention signals from PTY output, pause state, and exits:

- `awaiting-input`
- `idle-at-prompt`
- `quiet`
- `paused`
- `flow-controlled`
- `restoring`
- `exited-clean`
- `exited-error`

That state is server-authoritative and replayable, just like other backend-owned status.

Another newer backend service is task port tracking:

- `electron/ipc/task-ports.ts`

It keeps runtime task-port state split into:

- observed ports detected from PTY output
- explicitly exposed ports that the product is allowed to preview

That state is also server-authoritative and replayable.

### 7. Backend Entry / Handler Layer

Files:

- `electron/ipc/handlers.ts`
- `electron/ipc/register.ts`

Responsibilities:

- validate request shape
- map IPC names to workflows or low-level services
- bridge runtime-specific invocation into the backend

This layer is thinner than it used to be, but `handlers.ts` is still a hotspot because it remains the front door for a large backend surface area.

### 8. Runtime Server Shell Layer

Files:

- `electron/ipc/register.ts`
- `server/browser-server.ts`
- `server/main.ts`
- `electron/remote/server.ts`

Responsibilities:

- host the backend service layer in different runtime modes
- adapt the shared transport to each shell
- translate shell-specific requests into backend operations
- serve frontend assets in browser/remote modes

There are now fewer duplicated transport rules across these shells, but the shells still do a lot of work.

## Server-Owned Status Model

The current architecture intentionally treats some state as backend-owned:

- git status
- remote access status
- agent supervision / attention
- task port observation and exposure

The rule is:

1. backend detects or computes the state
2. backend pushes or replays it
3. clients project it into UI state
4. targeted refetch is a fallback, not the ownership model

This matters because it keeps reconnect semantics, multi-client behavior, and startup repair logic coherent across Electron and browser mode.

## Task Ports And Preview

Parallel Code now has a task-scoped preview model rather than a generic "proxy any localhost port" model.

The core distinction is:

- `ObservedPort`
  - backend heuristic
  - derived from PTY output
  - useful as a suggestion
  - not enough to expose a preview on its own
- `ExposedPort`
  - explicit allowlist entry owned by a task
  - safe enough to route through the product
  - replayed to reconnecting clients like other backend-owned state

Relevant files:

- `electron/ipc/port-detection.ts`
- `electron/ipc/task-ports.ts`
- `server/browser-preview.ts`
- `src/app/task-ports.ts`
- `src/components/PreviewPanel.tsx`

This follows the same ownership rule as other server-owned state:

1. backend detects or computes task port state
2. backend pushes and replays task port snapshots
3. clients project those snapshots into UI
4. browser mode proxies only explicitly exposed ports

That matters because Parallel Code runs tasks on the host, not in a strict sandbox. Detection is advisory, while exposure is explicit and task-scoped.

## Supervision And Attention Flow

The newest product-facing reliability feature is the task attention path.

### Backend

- `electron/ipc/pty.ts` emits spawn, output, pause, and exit signals
- `electron/ipc/agent-supervision.ts` converts those signals into canonical supervision snapshots
- Electron emits `agent_supervision_changed` through IPC
- browser/server mode replays the latest supervision snapshots through `server/browser-control-plane.ts`

### Frontend

- `src/app/desktop-session.ts` hydrates and buffers startup supervision events in Electron mode
- browser mode receives the same supervision events through the browser control plane
- `src/app/task-attention.ts` projects agent-level supervision into task-level attention entries
- `src/components/AttentionInbox.tsx` renders the sidebar attention surface

This is intentionally separate from simple task/agent dot status. Attention is a richer supervision concept, not just a color.

## Bundled Runtime Assets

Agent runtimes that the product claims to bundle need a runtime-asset resolution path that works across:

- local development
- Electron packaged layout
- standalone browser/server builds

Hydra now resolves through `electron/ipc/runtime-assets.ts` instead of assuming one compiled directory layout. The design principle is:

- bundled tools should either work everywhere the product claims they work
- or fail with a concrete reason that the UI can surface

## Core Concepts

### Projects

Defined in `src/store/types.ts` and managed mainly in `src/store/projects.ts`.

A project is the persistent repo-level configuration:

- path
- display name
- branch prefix
- delete-branch defaults
- default direct mode
- bookmarks

Projects matter to both task creation and git status lookup.

### Tasks

Defined in `src/store/types.ts` and managed mainly in `src/store/tasks.ts`.

A task is the main desktop-level unit. It carries:

- human name
- project association
- branch name
- worktree path
- agent IDs
- shell agent IDs
- notes
- prompt state
- plan content
- direct mode and permissions flags

The UI is task-centric. Agents are mostly viewed through the task that owns them.

### Agents

Defined in `src/store/types.ts`, backed by PTY sessions in `electron/ipc/pty.ts`.

An agent is the long-lived execution session. It carries:

- task ownership
- chosen agent definition
- current status
- exit information
- last output tail
- generation/restart identity

Status is partly authoritative from the backend and partly interpreted on the frontend.

### Terminals

Extra standalone terminal panels stored in `src/store/types.ts` and `src/store/terminals.ts`.

These are not the same as task agents. They are UI panels backed by shell agents, but conceptually they are side terminals rather than the primary task execution lane.

### Channels

Browser mode uses channel IDs to route PTY output over websocket.

Relevant files:

- `server/channel-frames.ts`
- `server/browser-channels.ts`
- `server/browser-server.ts`
- `src/lib/ipc.ts`
- `src/components/TerminalView.tsx`

Each browser terminal binds to a channel. The server routes PTY output to that channel. Rebind and scrollback restore are channel-level recovery mechanisms.

### Control Events

Control-plane websocket events include things like:

- `agent-lifecycle`
- `agent-controller`
- `remote-status`
- `git-status-changed`
- some `status` updates

These now use replayable sequencing in `electron/remote/ws-transport.ts`.

## Runtime Shapes

### Electron Desktop

Main files:

- `electron/main.ts`
- `electron/ipc/register.ts`
- `src/App.tsx`
- `src/lib/ipc.ts`

Shape:

- frontend runs inside Electron
- frontend calls backend via `window.electron.ipcRenderer`
- backend work is handled through `createIpcHandlers(...)`
- no browser websocket transport is required for the main desktop UI

Electron mode is the most direct path: renderer -> Electron IPC -> backend services.

### Browser Desktop

Main files:

- `server/main.ts`
- `server/browser-server.ts`
- `src/App.tsx`
- `src/lib/ipc.ts`
- `src/runtime/browser-session.ts`

Shape:

- a standalone Node/Express server serves the desktop UI
- the frontend still imports the same store/UI code
- command-style calls go over HTTP IPC
- terminal and event streams go over websocket

Browser mode is the most complex runtime because it combines:

- HTTP command/query plane for request/response backend commands
- websocket control plane for sequenced control events
- websocket channel plane for PTY output
- authenticated preview proxy routes for explicitly exposed task ports

Those three planes are now explicit in code:

- `src/lib/browser-http-ipc.ts`
- `src/lib/browser-control-client.ts`
- `src/lib/browser-channel-client.ts`

`src/lib/ipc.ts` remains the façade that makes browser mode feel close to Electron mode to the rest of the UI.

Preview routing is handled separately in:

- `server/browser-preview.ts`

It is intentionally not part of the websocket transport. Preview is an authenticated HTTP/WebSocket reverse-proxy concern layered on top of task-scoped exposure state.

### Remote/Mobile

Main files:

- `electron/remote/server.ts`
- `electron/remote/http-handler.ts`
- `electron/remote/ws-server.ts`
- `src/remote/App.tsx`
- `src/remote/ws.ts`

Shape:

- a separate mobile SPA is served from the remote server
- remote UI talks directly to the shared websocket transport
- remote mode does not reuse the full desktop store
- remote mode operates against a smaller agent-oriented projection of the system

This runtime is simpler than browser desktop, but it uses a different UI model and slightly different message patterns.

## End-to-End Flows

### 1. Desktop App Startup in Electron Mode

Flow:

1. `src/index.tsx` renders `src/App.tsx`
2. `src/App.tsx` delegates desktop startup/session coordination to `src/app/desktop-session.ts`
3. `src/app/desktop-session.ts` sets up:
   - window session hooks
   - shortcuts
   - autosave
   - startup reconciliation
   - app-level listeners
4. `loadAgents()` and `loadState()` populate the client store
5. `electron/ipc/register.ts` has already registered `createIpcHandlers(...)` with `ipcMain.handle(...)`
6. subsequent UI actions call store functions or app workflows, which invoke backend operations through `src/lib/ipc.ts`

Important property:

- Electron mode uses the same frontend store and UI surface as browser mode, but a different transport path.

### 2. Desktop App Startup in Browser Mode

Flow:

1. `server/main.ts` bootstraps `server/browser-server.ts`
2. the frontend loads `src/App.tsx`
3. `src/App.tsx` initializes the same store and root UI shell
4. `src/app/desktop-session.ts` coordinates the shared desktop startup path
5. `src/runtime/browser-session.ts` registers browser-only runtime listeners
6. `src/lib/ipc.ts` composes:
   - `src/lib/browser-http-ipc.ts`
   - `src/lib/browser-control-client.ts`
   - `src/lib/browser-channel-client.ts`
7. state is loaded via the HTTP command/query plane
8. ongoing control updates arrive over the websocket control plane
9. terminal output arrives over the websocket channel plane

Important property:

- browser mode is intentionally shaped to feel like Electron mode to the UI, but the actual transport is explicitly split under the surface.

### 3. Remote/Mobile Startup

Flow:

1. `electron/ipc/register.ts` can start `electron/remote/server.ts`
2. `electron/remote/server.ts` composes `electron/remote/http-handler.ts` and `electron/remote/ws-server.ts`
3. the remote server serves the mobile SPA
4. `src/remote/App.tsx` runs a much smaller app shell
5. `src/remote/ws.ts` connects through the shared websocket client core
6. the remote UI receives:
   - `agents`
   - `status`
   - `output`
   - `scrollback`

Important property:

- remote/mobile is not "the desktop UI in a smaller layout"
- it is a separate agent-view application sharing backend services and transport rules

### 4. Spawn Task / Spawn Agent Flow

Desktop flow:

1. user triggers a task action in the UI
2. component calls a store or app-workflow action
3. frontend workflow modules like `src/app/task-workflows.ts` decide the higher-level behavior
4. backend IPC is invoked through `src/lib/ipc.ts`
5. Electron mode routes that through `window.electron.ipcRenderer.invoke(...)`
6. browser mode routes it through the HTTP IPC endpoint registered by `server/browser-ipc.ts`
7. `electron/ipc/handlers.ts` validates input and delegates to backend workflows or low-level services
8. backend workflow modules like `electron/ipc/task-workflows.ts` orchestrate:
   - task creation/deletion
   - watcher setup or teardown
   - PTY spawn coordination
   - follow-up refresh or cleanup
9. low-level services like `electron/ipc/tasks.ts`, `electron/ipc/pty.ts`, and `electron/ipc/git.ts` perform the underlying work
10. the frontend store updates based on:
    - direct request success
    - PTY lifecycle events
    - websocket control messages

Important property:

- there is now a real workflow layer on both the frontend and backend
- the remaining architectural question is how far to keep moving orchestration out of store slices and large handlers

### 4b. Task Port Detection / Exposure / Preview Flow

Flow:

1. `electron/ipc/pty.ts` streams task output
2. `electron/ipc/port-detection.ts` extracts likely localhost ports from output
3. `electron/ipc/task-ports.ts` updates the runtime task-port registry
4. renderer clients receive pushed `task-ports-changed` events through:
   - Electron IPC in desktop mode
   - browser control-plane replay/push in browser mode
5. `src/app/task-ports.ts` projects those snapshots into preview state and URLs
6. `src/components/PreviewPanel.tsx` lets the user expose or unexpose ports
7. browser mode opens exposed ports through `/_preview/:taskId/:port/*`

Important properties:

- detection is advisory
- exposure is explicit
- preview state is replayable after reconnect
- task deletion clears task-port state

### 5. Terminal Output Flow

Electron mode:

1. `electron/ipc/pty.ts` receives PTY bytes
2. output is batched and forwarded through the Electron channel bridge
3. `src/components/TerminalView.tsx` writes output into xterm
4. `src/store/taskStatus.ts` observes recent output tails and updates question/prompt state

Browser mode:

1. `electron/ipc/pty.ts` emits output to a browser-mode channel callback
2. `server/browser-channels.ts` packages output via `server/channel-frames.ts`
3. per-client/per-channel fanout and backpressure rules are applied
4. channel frames are sent over websocket
5. `src/lib/ipc.ts` routes channel payloads to terminal listeners
6. `src/components/TerminalView.tsx` writes output into xterm
7. status/prompt detection runs in the frontend

Important property:

- terminal output is the most performance-sensitive path
- it cuts across PTY, server shell, transport, and UI
- that is why this area still resists aggressive abstraction

### 6. Scrollback Recovery and Rebind Flow

Browser mode only:

1. terminals bind a channel over websocket
2. if the socket drops, the server may retain channel backlog briefly
3. if backlog is too old or too large, the server marks the channel `ResetRequired`
4. `src/components/TerminalView.tsx` requests batched restore through `src/lib/scrollbackRestore.ts`
5. browser IPC uses HTTP IPC to fetch scrollback
6. the terminal rehydrates and resumes live output

Important property:

- the recovery model is reset-and-restore, not exact message replay for terminal output
- this is simpler than per-frame replay but still conceptually heavy

### 7. Pause / Resume / Flow-Control / Restore Flow

Files:

- `electron/ipc/pty.ts`
- `electron/remote/protocol.ts`
- `electron/remote/ws-transport.ts`
- `src/runtime/server-sync.ts`
- `src/store/taskStatus.ts`

Flow:

1. PTY pause state is tracked by pause reasons in `electron/ipc/pty.ts`
2. reasons include:
   - `manual`
   - `flow-control`
   - `restore`
3. protocol helpers translate pause reasons into user-facing agent status
4. transport broadcasts lifecycle/control events
5. frontend runtime sync converts those messages into store updates
6. UI components render those states through badges and status dots

Important property:

- this is one of the best examples of a concept crossing many layers
- the protocol is shared, but the status derivation is still duplicated in a few places

### 8. Multi-Client Control Flow

Files:

- `electron/remote/ws-transport.ts`
- `server/browser-server.ts`
- `server/browser-websocket.ts`
- `electron/remote/server.ts`

Flow:

1. an interactive command arrives from a websocket client
2. the shell checks whether that action requires control ownership
3. the shared transport layer enforces a short controller lease per agent
4. on success, the backend command executes
5. controller changes are broadcast as replayable control events

Important property:

- controller ownership now lives in one place
- command execution still lives in the shell that is handling the websocket message

### 9. Git Status Flow

Files:

- `electron/ipc/git.ts`
- `electron/ipc/git-watcher.ts`
- `electron/ipc/git-status-workflows.ts`
- `server/browser-control-plane.ts`
- `src/app/git-status-sync.ts`
- `src/runtime/server-sync.ts`

Current shape:

- browser mode prefers server-owned push and replay for git state
- Electron mode still has a more mixed push/pull model

Flow:

1. backend watchers or git mutations invalidate or refresh git state
2. `electron/ipc/git.ts` computes and caches worktree status
3. `electron/ipc/git-status-workflows.ts` builds the normalized git payload and emits it to the relevant runtime
4. in browser mode:
   - `server/browser-control-plane.ts` keeps the latest worktree snapshot
   - authenticated clients receive replay of current snapshots
   - live clients receive `git-status-changed` pushes
   - the browser runtime updates local state from pushed payloads instead of polling for server-owned git state
5. in Electron mode:
   - direct IPC refresh still exists
   - watcher and invalidation flows still coexist with refresh-on-demand
6. `src/app/git-status-sync.ts` and `src/runtime/server-sync.ts` map pushed browser events into store updates

Important property:

- browser mode now has a clear canonical path: backend owns git state, server pushes and replays it
- Electron mode is better than before, but still the main remaining place where git state is not fully server-authoritative

### 10. Persistence and Reconciliation Flow

Files:

- `src/store/persistence.ts`
- `electron/ipc/storage.ts`
- `src/runtime/server-sync.ts`
- `src/runtime/window-session.ts`

Flow:

1. the frontend periodically saves app state
2. backend storage persists it
3. on startup, saved state is loaded back into the store
4. runtime reconciliation then checks live backend state against loaded store state
5. missing agents are marked exited and notifications may be shown

Important property:

- persisted state is not considered fully authoritative
- runtime reconciliation is a second pass that repairs persisted assumptions using live backend data

### 11. Remote Access Status Flow

Files:

- `src/app/remote-access.ts`
- `src/store/remote.ts`
- `src/runtime/browser-session.ts`
- `server/browser-control-plane.ts`
- `electron/ipc/remote-access-workflows.ts`
- `electron/remote/server.ts`

Flow:

1. Electron can start or stop the remote/mobile server through backend remote-access workflows
2. backend workflows map server state into a discriminated enabled/disabled remote-status contract
3. browser mode also exposes browser-client presence through websocket `remote-status` events
4. the frontend store keeps both:
   - `connectedClients`
   - `peerClients`
5. UI components render availability, current session, and peer-presence state

Important property:

- the status shape is now cleaner and more explicit than before
- the remaining gap is semantic alignment: browser mode has a richer peer/client distinction than Electron remote hosting

## Where The Architecture Is Cleanest

These areas are in reasonably good shape:

- shared websocket client behavior in `src/lib/websocket-client.ts`
- shared websocket server behavior in `electron/remote/ws-transport.ts`
- protocol vocabulary in `electron/remote/protocol.ts`
- explicit browser transport planes in:
  - `src/lib/browser-http-ipc.ts`
  - `src/lib/browser-control-client.ts`
  - `src/lib/browser-channel-client.ts`
- runtime extraction from `src/App.tsx` into `src/runtime/*` and `src/app/*`
- backend workflow modules in:
  - `electron/ipc/task-workflows.ts`
  - `electron/ipc/git-status-workflows.ts`
  - `electron/ipc/remote-access-workflows.ts`
- browser control-plane snapshot/replay ownership in `server/browser-control-plane.ts`
- browser-only channel framing extracted into `server/channel-frames.ts`

These areas have a clear reason to exist and a clear boundary.

## Where The Architecture Is Still Mixed

### 1. The Store Is Cleaner, But Still Not Just A Projection Layer

The store now has more help from `src/app/*` workflow modules, but it still owns a mix of:

- pure client state
- UI mutations
- status derivation
- persistence behavior
- some workflow-style orchestration

Why this matters:

- components still reach into store APIs that may mutate local state, talk to the backend, or both
- the boundary between state projection and application behavior is better than before, but still not fully crisp

### 2. Browser Mode Is Explicit, But Still Conceptually Heavy

Browser mode is now correctly expressed as three planes:

- HTTP command/query plane
- websocket control plane
- websocket channel plane

That is the right model, but it is still inherently the most complex runtime.

Why this matters:

- `src/lib/ipc.ts` is still a high-value façade and lifecycle hotspot
- reconnect behavior spans queue replay, control replay, and channel restore
- new features still need discipline to stay inside the right plane

### 3. `server/browser-server.ts` Is Thinner, But Still The Heaviest Shell

Recent work moved major browser responsibilities into:

- `server/browser-ipc.ts`
- `server/browser-websocket.ts`
- `server/browser-channels.ts`
- `server/browser-control-plane.ts`

That said, `server/browser-server.ts` still owns:

- top-level browser server composition
- shutdown wiring
- backend composition for browser mode
- server-info and presence coordination

Why this matters:

- the shell is now understandable, but still one of the easiest places for browser-only drift to reappear

### 4. Backend Workflows Exist, But The Service Surface Is Still Large

The backend now has a real workflow layer, which is a major improvement. The remaining problem is not the lack of workflows. It is that the low-level service and handler surface is still large and uneven.

Hotspots:

- `electron/ipc/handlers.ts`
- `electron/ipc/git.ts`
- `electron/ipc/tasks.ts`

Why this matters:

- large capability modules still make it easy to smuggle use-case behavior back into services
- the next quality gains are likely to come from shrinking and clarifying these modules, not from inventing more new layers

### 5. The Protocol Is Shared, But The Projections Are Still Different By Design

The desktop UI is task-centric. The remote/mobile UI is agent-centric. Browser mode adds channel framing for terminal output.

That is not a bug. It is an accurate reflection of the product surfaces. The remaining challenge is keeping the shared concepts consistent across those projections.

Why this matters:

- new features must decide whether they belong to the shared concept, the desktop projection, the remote projection, or only one transport plane

### 6. Canonical Derivation Is Better, But Not Fully Closed

Recent work improved several concepts:

- backend canonical agent status now exists
- browser git state now prefers server-owned push/replay
- remote-access status now uses a clearer enabled/disabled contract

Still mixed:

- Electron git state still uses a more mixed refresh model than browser mode
- user-visible task/agent status still crosses backend status, runtime sync, and frontend projection helpers
- remote presence semantics are aligned in shape, but not fully identical in meaning across runtimes

Why this matters:

- these are the remaining high-value sources of semantic drift

### 7. Global Singletons Still Make Lifecycle More Implicit Than Ideal

Examples:

- module-scope websocket clients
- module-scope store
- module-scope pending request queues
- module-scope PTY session registries

Why this matters:

- it keeps call sites simple
- it still hides some ownership, startup order, and teardown rules

### 8. Type Boundaries Are Better, But Not Yet Uniform

Recent work added stronger typing and stricter compiler passes for lifecycle-heavy modules.

Still weaker:

- some IPC event payloads are still narrowed from generic runtime shapes
- some protocol/store/shared-domain concepts still have parallel type surfaces
- strict optional/indexed-access guarantees are not yet universal across the whole repo

Why this matters:

- the highest-risk paths are in better shape
- the long-term quality goal is to make the safer type discipline boring and normal everywhere

## Architectural Principles To Evaluate Against

These are the principles that best fit the current codebase and the direction of the recent simplification work:

### 1. Server-owned state should be pushed from the server when practical

Best example:

- browser-mode git state now prefers backend watcher/mutation updates, server-side snapshot replay, and pushed `git-status-changed` events

Why this matters:

- it reduces client polling drift
- it makes reconnect behavior easier to define

### 2. Shared concepts should have one canonical representation

Good examples:

- websocket transport rules
- control-event sequencing
- backend canonical agent status

Still weak:

- full task/agent presentation state across backend, runtime sync, and store projections

### 3. Workflows should own multi-step use cases

Good examples:

- `src/app/task-workflows.ts`
- `electron/ipc/task-workflows.ts`
- `electron/ipc/git-status-workflows.ts`
- `electron/ipc/remote-access-workflows.ts`

Why this matters:

- it keeps handlers thin
- it keeps low-level services honest
- it gives tests a stable unit for end-to-end behavior

### 4. Runtime adapters should translate transport/runtime concerns, not own business logic

Good examples:

- `src/runtime/window-session.ts`
- `src/runtime/drag-drop.ts`
- browser transport split across explicit browser planes

Still mixed:

- browser reconciliation and some runtime sync still blend translation with policy

### 5. Server shells should compose services, not become services

Good:

- shared websocket transport extraction
- browser shell decomposition into IPC, control-plane, websocket, and channel modules

Still mixed:

- `server/browser-server.ts` remains the heaviest composition root

### 6. The store should trend toward projection and local UI state

Good:

- more orchestration now lives in `src/app/*`

Still mixed:

- store slices still carry some transport-aware or workflow-style behavior

### 7. Recovery behavior should be explicit and observable

Good:

- connection banners
- replay cursors
- control replay
- reset-and-restore signaling
- typed browser runtime lifecycle transitions

Why this matters:

- recovery is one of the hardest places for quality to drift silently

### 8. The terminal path is special and should stay explicit

The terminal/output path crosses PTY services, transport, browser channel fanout, and UI rendering. The goal here is not fake uniformity. The goal is clear contracts, explicit backpressure rules, and explicit recovery semantics.

### 9. Type boundaries should make lifecycle mistakes hard to express

Good:

- stricter lifecycle typecheck pass
- typestate-style lifecycle handling in key transport/runtime code

Still mixed:

- some runtime boundaries still narrow generic payloads late

### 10. Tests should protect architecture contracts and product behavior, not current plumbing

Good:

- node-side contract and reliability tests cover replay, control lease, reconnect, transport, latency, and browser-server behavior
- Solid screen tests now cover high-churn user-facing flows such as task actions, terminal lifecycle, sidebar behavior, pushed git updates, and remote-access UI behavior

Why this matters:

- architectural cleanup is only durable if tests pin the contracts that should survive refactors
- usability regressions usually appear first in high-churn screens, not in low-level helpers

## Testing Strategy

The current test strategy is intentionally split by runtime and by risk profile.

### 1. Node / Contract / Reliability Suite

Runs through `vitest.config.ts`.

What it protects:

- backend workflows
- PTY behavior
- websocket transport
- browser server shell behavior
- reconnect and replay contracts
- lifecycle race handling
- startup/reconciliation logic that does not require a DOM

This suite should answer:

- does the system remain correct under reconnect, backpressure, replay, and multi-client control?
- does server-owned state remain canonical and replayable?
- do workflows still orchestrate the right backend behavior?

### 2. Solid / Product-Behavior Suite

Runs through `vitest.solid.config.ts`.

What it protects:

- `TaskPanel.tsx`
- `TerminalView.tsx`
- `Sidebar.tsx`
- `ChangedFilesList.tsx`
- `ReviewPanel.tsx`
- `ConnectPhoneModal.tsx`

This suite should answer:

- do high-churn screens still behave correctly from the user's perspective?
- do browser and Electron UI surfaces react correctly to pushed server-owned state?
- do focus, dialog, retry, and refresh behaviors still work after refactors?

### 3. Startup / Persistence / Reconciliation Coverage

Targets:

- `src/app/desktop-session.ts`
- `src/store/persistence.ts`

This is a separate category because startup bugs are usually hard to debug and easy to miss in feature work.

The important contracts here are:

- early pushed server events are not lost during startup
- stale persisted state is repaired rather than amplified
- cleanup before boot completion does not leak stale buffered events
- persistence migration remains backward-compatible

### Testing Principles

The current testing direction should stay aligned with these rules:

1. Prefer tests that assert user-visible or system-visible behavior.
2. Prefer server-authoritative contracts for server-owned state.
3. Prefer race and replay coverage over shallow collaborator-call assertions.
4. Use node tests for transport and lifecycle contracts.
5. Use Solid/jsdom tests for churn-heavy UI behavior.
6. Avoid encoding temporary implementation details as invariants unless they are true design constraints.

## Practical Delta Summary

If we compare the current system to the direction above, the delta is not "we need a new architecture".

The delta is narrower:

1. keep product-behavior coverage expanding with the highest-churn UI surfaces
2. keep startup, persistence, and reconciliation coverage strong as those flows evolve
3. keep tightening canonical derivation and shared type contracts where new features touch them
4. keep server-owned state push/replay semantics boring and consistent across runtimes

That means the next useful architectural work is not another transport rewrite. It is targeted cleanup around ownership, derivation, and type boundaries.

## Current Direction

The current architectural approach is:

1. keep the shared transport core stable
2. make browser mode explicit instead of pretending it is a single transport
3. prefer workflow modules for multi-step behavior
4. prefer server-pushed state for server-owned concepts
5. keep composition roots thin and keep business logic out of runtime adapters
6. use stronger typing to catch lifecycle drift before runtime

This is the path the recent phases have already been moving along.

## Current Gaps

The architecture is in a better state than the earlier refactor phases assumed. The remaining gaps are narrower and more product-facing.

### 1. Product-Behavior Coverage Should Keep Growing With The Product

Recent work added direct screen coverage for the highest-churn UI surfaces, which is a major improvement.

What still matters:

- keep adding screen tests when task creation, focus management, terminal UX, or review flows evolve
- add app-level scenario coverage when reconnect, restore, and pushed state behavior become more sophisticated

### 2. Startup And Reconciliation Remain High-Risk Areas

`desktop-session.ts` and persistence now have direct integration tests, but startup remains one of the easiest places for subtle regressions.

Why this matters:

- startup order bugs often look nondeterministic
- stale persisted state can silently corrupt UI assumptions if the tests drift

### 3. A Few Shared Concepts Still Have More Than One Projection

This is much better than before, but still worth watching when future features land:

- task/agent presentation state across backend derivation, runtime sync, and store helpers
- remote presence semantics across desktop host mode and browser mode
- git refresh behavior in advanced or future UI surfaces

### 4. The Terminal Path Is Still Intentionally Complex

That is acceptable, but it means terminal-related feature work should continue to treat:

- PTY behavior
- websocket/channel behavior
- UI recovery behavior

as one reliability-sensitive path, not as isolated modules.

## Next Phases

The next quality phases should build on the current direction instead of changing it.

### Phase 8: Expand Product-Behavior And Scenario Coverage

Goal:

- make high-churn user-facing flows harder to regress as the product grows

Targets:

- add deeper focus/keyboard/navigation coverage where task and sidebar behavior changes
- add app-level browser-mode scenarios for reconnect, restore, and pushed server state
- extend screen coverage when advanced review, terminal, or remote-control features are added

### Phase 9: Keep Tightening Shared Domain And Type Boundaries Opportunistically

Goal:

- use feature work to eliminate remaining parallel concept surfaces instead of launching another broad refactor campaign

Targets:

- reduce late `unknown` narrowing at runtime boundaries
- keep event maps and protocol contracts canonical
- continue widening stricter typing where it removes a real bug class

Why this order:

- the biggest remaining risk is no longer transport drift
- it is product-behavior regressions and subtle semantic drift under future feature growth

## Recommended Questions For Future Refactors

When evaluating a new change, ask:

1. Which runtime shells does this feature touch?
2. Is this concept task-centric, agent-centric, transport-centric, or workflow-centric?
3. Is the server or the client actually responsible for this state?
4. Is there already a canonical place where this state should be derived?
5. Is this logic transport behavior, workflow behavior, backend service behavior, or UI behavior?
6. If browser mode needs special handling, does it belong in the HTTP plane, control plane, or channel plane?
7. Are we adding a new message shape when an existing protocol concept should be extended instead?

If those answers are not obvious, that is usually a sign the change is crossing the wrong layer.
