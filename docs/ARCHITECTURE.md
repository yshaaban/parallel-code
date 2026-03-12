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
- a `Terminal` is an extra shell panel in the UI, not the same thing as an agent
- a `Channel` is a transport output stream binding used primarily in browser mode
- a `ServerMessage` / `ClientMessage` pair is the websocket control vocabulary

The architecture is not fully layered in a classic clean-architecture sense. It is closer to:

- shared domain-ish state and helpers
- runtime-specific transport adapters
- UI and server shells that still contain a fair amount of orchestration

That is important, because a lot of the current complexity comes from orchestration living at the edges instead of in a single application-service layer.

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
- subscribe to store state
- wire runtime setup and teardown

This layer is thinner than it used to be, but `src/App.tsx` is still an orchestration shell rather than a pure root component.

### 2. Runtime Adapter Layer

Files:

- `src/runtime/browser-session.ts`
- `src/runtime/server-sync.ts`
- `src/runtime/window-session.ts`
- `src/runtime/drag-drop.ts`
- `src/runtime/app-shortcuts.ts`
- `src/lib/ipc.ts`
- `src/remote/ws.ts`

Responsibilities:

- adapt the UI to Electron mode vs browser mode vs remote/mobile mode
- manage websocket lifecycle, browser reconnection, connection banners, queueing
- manage window lifecycle in Electron mode
- translate transport events into store updates

This is the most important architectural seam added in the recent cleanup. It is now much clearer where "runtime wiring" lives.

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

This is the cleanest part of the current architecture. The transport rules are much more centralized than they were before.

### 4. Application State Layer

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
- expose mutations and orchestrated workflows
- own persistence loading/saving logic
- derive task/agent status for presentation

This layer is useful, but it is not "just state". It also acts as an application-service facade. That is one of the main sources of architectural muddiness.

### 5. Backend Service Layer

Files:

- `electron/ipc/handlers.ts`
- `electron/ipc/pty.ts`
- `electron/ipc/git.ts`
- `electron/ipc/tasks.ts`
- `electron/ipc/storage.ts`
- `electron/ipc/git-watcher.ts`
- `electron/ipc/plans.ts`

Responsibilities:

- spawn and manage PTY sessions
- manipulate worktrees, branches, diffs, and commits
- persist and reload app state
- expose a command surface to Electron mode and browser mode

This is the real backend of the product, even though it is not expressed as a separate service layer in the codebase.

### 6. Runtime Server Shell Layer

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

- HTTP for request/response backend commands
- websocket for control-plane events
- websocket channels for PTY output

This is the biggest source of conceptual complexity in the product.

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
2. `src/App.tsx` sets up:
   - window session hooks
   - shortcuts
   - autosave
   - task status polling
   - plan content listener
3. `loadAgents()` and `loadState()` populate the client store
4. `electron/ipc/register.ts` has already registered `createIpcHandlers(...)` with `ipcMain.handle(...)`
5. subsequent UI actions call store functions, which call `invoke(...)` through `src/lib/ipc.ts`

Important property:

- Electron mode uses the same frontend store and UI surface as browser mode, but a different transport path.

### 2. Desktop App Startup in Browser Mode

Flow:

1. `server/main.ts` bootstraps `server/browser-server.ts`
2. the frontend loads `src/App.tsx`
3. `src/App.tsx` initializes the same store and root UI shell
4. `src/runtime/browser-session.ts` registers browser-only runtime listeners
5. `src/lib/ipc.ts` creates and manages the browser websocket client and HTTP fallback/queue behavior
6. state is loaded via HTTP IPC calls
7. ongoing control updates arrive over websocket
8. terminal output arrives over bound channels

Important property:

- browser mode is intentionally shaped to feel like Electron mode to the UI, but the actual transport is split under the surface.

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
2. component calls a store action from `src/store/tasks.ts`
3. the store action calls backend IPC via `src/lib/ipc.ts`
4. Electron mode routes that through `window.electron.ipcRenderer.invoke(...)`
5. browser mode routes it through the HTTP IPC endpoint registered by `server/browser-ipc.ts`
6. `electron/ipc/handlers.ts` validates input and delegates to:
   - `electron/ipc/tasks.ts`
   - `electron/ipc/pty.ts`
   - related git/storage helpers
7. `electron/ipc/pty.ts` spawns the PTY session and begins emitting lifecycle events
8. the frontend store updates based on:
   - direct request success
   - PTY lifecycle events
   - websocket control messages

Important property:

- the store action and the backend handler both participate in the workflow
- there is no single application-service layer that owns the full use case end-to-end

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
- `src/store/git-status-polling.ts`
- `src/runtime/server-sync.ts`

There are two ways git status moves through the system:

1. pull-based polling from the desktop store
2. push-style refresh events from backend watchers and server events

Flow:

1. backend watchers notice changes or frontend polling requests a refresh
2. `electron/ipc/git.ts` computes and caches worktree status
3. Electron mode receives results directly via IPC
4. browser mode may receive either:
   - HTTP IPC responses
   - websocket `git-status-changed`
   - IPC-event style pushes from the browser server shell
5. `src/runtime/server-sync.ts` maps those pushes back into store refreshes

Important property:

- git status is functionally correct but uses both push and pull paths
- that makes it harder to identify one canonical flow

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

- `src/store/remote.ts`
- `src/runtime/browser-session.ts`
- `server/browser-server.ts`
- `electron/ipc/register.ts`
- `electron/remote/server.ts`

Flow:

1. Electron can start the remote/mobile server
2. remote connection counts are tracked on the backend
3. browser mode also exposes browser-client presence through websocket events
4. the frontend store keeps both:
   - `connectedClients`
   - `peerClients`
5. UI components render connection and peer-presence state

Important property:

- this is functionally better than before, but the concept of "client count" still means slightly different things across runtime modes

## Where The Architecture Is Cleanest

These areas are in reasonably good shape:

- shared websocket client behavior in `src/lib/websocket-client.ts`
- shared websocket server behavior in `electron/remote/ws-transport.ts`
- protocol vocabulary in `electron/remote/protocol.ts`
- runtime extraction from `src/App.tsx` into `src/runtime/*`
- large component extraction in `src/components/*`
- browser-only channel framing extracted into `server/channel-frames.ts`

These areas have a clear reason to exist and a clear boundary.

## Where The Architecture Is Still Mixed

### 1. The Store Is Both State Layer And Application-Service Layer

`src/store/store.ts` is a barrel over many domain modules, which is fine, but the store subsystem still owns:

- pure client state
- UI mutations
- transport-triggering workflows
- reconciliation behavior
- business-ish logic like prompt and trust handling

That means components often call store functions that are doing much more than state mutation.

Why this matters:

- it makes the store easy to use but harder to reason about architecturally
- it is not obvious which workflows are purely local and which round-trip to the backend

### 2. Browser Mode Uses Two Command Planes

Browser mode intentionally uses:

- HTTP IPC for request/response commands
- websocket for events and channel output

That is the right practical tradeoff for reliability, but it is conceptually expensive. The desktop UI feels like one app, while the browser runtime is actually speaking through two transport models at once.

Why this matters:

- command ownership is harder to trace
- reconnect behavior needs both HTTP queue logic and websocket recovery logic
- the frontend runtime layer must hide a lot of mode-specific behavior

### 3. `server/browser-server.ts` Is Still A Large Browser Shell

Recent work removed the shared transport duplication, and `server/main.ts` is now just a bootstrap.
The remaining browser-shell coordination lives mostly in `server/browser-server.ts`, which still mixes:

- top-level browser server composition
- startup logging and shutdown wiring
- browser-specific websocket batching and send behavior
- backend service composition for HTTP IPC, websocket sessions, and channel fanout

Why this matters:

- browser mode is much clearer than before, but the shell still owns several distinct concerns
- the composition root is slimmer, not yet minimal

### 4. Backend Use Cases Are Split Across Handlers And Lower-Level Services

For example, a task/agent action may span:

- `src/store/tasks.ts`
- `src/lib/ipc.ts`
- `electron/ipc/handlers.ts`
- `electron/ipc/tasks.ts`
- `electron/ipc/pty.ts`

That is workable, but there is no clearly named application layer expressing "spawn task", "merge task", "close task", or "start remote access" as first-class use cases.

Why this matters:

- the backend logic is real, but the use-case boundaries are implicit
- validation, orchestration, and side effects are distributed across layers

### 5. The Protocol Is Shared, But The UI Projections Are Not

The desktop UI is task-centric. The remote/mobile UI is agent-centric. Browser mode also introduces channel framing for terminal output.

So the architecture has:

- one shared protocol vocabulary
- multiple UI projections of the same backend state
- multiple output transport shapes

Why this matters:

- the model is accurate, but not simple
- new features must decide whether they belong to the task view, the agent view, or both

### 6. Several Concepts Are Derived In Multiple Places

Examples:

- agent status is derived from PTY pause reason, transport messages, and frontend state helpers
- git status can come from polling, watcher pushes, or full refresh
- remote presence is derived slightly differently across runtime modes

Why this matters:

- duplicated derivation increases drift risk
- it becomes harder to identify one canonical source of truth for a concept

### 7. Global Singletons Make Lifecycle Implicit

Examples:

- module-scope websocket clients
- module-scope store
- module-scope pending request queues
- module-scope PTY session registries

Why this matters:

- it keeps the code simple to call
- it also makes boot order, cleanup, and testing more implicit than ideal

### 8. Type Boundaries Are Still Loose In A Few Critical Paths

Examples:

- some IPC event payloads are still `unknown`
- some websocket message routing narrows from generic message shapes at runtime
- channel payloads are intentionally opaque at part of the stack

Why this matters:

- the runtime behavior is tested
- the architectural contracts are still looser than they could be

## Architectural Principles To Evaluate Against

These are the principles that best fit the current codebase and the direction of the recent simplification work:

### 1. Shared concepts should have one canonical representation

Good examples:

- websocket transport rules
- control-event sequencing

Still weak:

- task/agent lifecycle ownership across store, handler, and PTY layers

### 2. Runtime adapters should translate, not own business logic

Good examples:

- `src/runtime/window-session.ts`
- `src/runtime/drag-drop.ts`

Still mixed:

- browser runtime reconciliation and some server sync logic
- browser server shell behavior in `server/browser-server.ts`

### 3. Server shells should compose services, not become services

Good:

- shared websocket transport extraction
- extracted helper modules like `server/channel-frames.ts`

Still mixed:

- `server/browser-server.ts`
- some coordination inside `electron/remote/server.ts`, though HTTP and websocket concerns are now split out

### 4. UI components should consume state, not explain transport

Good:

- component splits in `TaskPanel`, `Sidebar`, remote gesture handling

Still mixed:

- `TerminalView.tsx` must still know a lot about transport/recovery semantics because the terminal path is special

### 5. Recovery behavior should be explicit and observable

Good:

- connection banners
- replay cursors
- control replay
- reset-and-restore signaling

Still mixed:

- browser mode still has a lot of transport complexity hidden under `src/lib/ipc.ts`

## Practical Delta Summary

If we compare the current system to the architectural direction we appear to want, the delta is not "we need a totally different architecture".

The delta is narrower:

1. too much orchestration still lives in the store and browser server shell
2. browser mode still carries the most conceptual load because it uses HTTP IPC plus websocket events plus channel binding
3. several domain concepts still have more than one derivation path
4. the backend has useful services, but not a clearly named application layer for end-to-end use cases

That means the next useful architectural work is likely not another transport rewrite. It is:

- clarifying use-case ownership
- reducing browser-shell coordination in `server/browser-server.ts`
- tightening canonical status and event derivation
- deciding how much of the store should stay a workflow facade versus moving toward explicit app services

## Recommended Questions For Future Refactors

When evaluating a new change, ask:

1. Which runtime shells does this feature touch?
2. Is this concept task-centric, agent-centric, or transport-centric?
3. Is there already a canonical place where this state should be derived?
4. Is this logic transport behavior, application behavior, or UI behavior?
5. If browser mode needs special handling, can that live in a runtime adapter instead of in a component or shared domain module?
6. Are we adding a new message shape when an existing protocol concept should be extended instead?

If those answers are not obvious, that is usually a sign the change is crossing the wrong layer.
