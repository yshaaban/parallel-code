# Architecture Walkthrough

Read [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) first if you are deciding where code should live or whether a change is aligned with the repo direction. Read [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) when you are porting changes from upstream or explaining why a direct cherry-pick is not appropriate.
For the practical contributor workflow around browser terminals, restore, browser-lab validation,
and non-obvious terminal lifecycle rules, read
[TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md).

This document explains the current architecture of Parallel Code as it exists after the recent
browser control, multi-client, terminal-attach, and browser-lab work.

It is intentionally not a design manifesto. It is a map of:

1. what the system is
2. how data actually flows today
3. which layers are reasonably clean
4. where the architecture is still mixed or awkward

Use this as the reference point for current runtime structure and data flow. Use the principles document as the normative guide for ownership, layering, and do/don't rules.

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
- `src/app/terminal-attach-scheduler.ts`
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
- `PeerPresence` is ephemeral per-browser-session identity plus focus/control context
- a task takeover request is a live control-plane workflow, not persisted workspace state
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

Two current ownership splits matter in review:

- `src/App.tsx` is the desktop shell composition root: it keeps session/bootstrap wiring, root
  dialog policy, and takeover/display-name workflow state, while `src/components/app-shell/*`
  stays presentational shell chrome
- `src/app/app-startup-status.ts` owns the shared startup summary consumed by
  `DisplayNameDialog.tsx` and `TerminalStartupChip.tsx`, while `src/app/desktop-session.ts` and
  `src/app/desktop-session-startup.ts` own the coarse bootstrap/restore lifecycle updates that feed
  it
- `src/store/sidebar-section-state.ts` owns the canonical sidebar chrome collapse defaults and
  normalization, `src/store/sidebar-sections.ts` owns the live store toggle helpers,
  `src/store/client-session.ts` owns the browser-local persistence for that shell state, the
  Electron full-state path in `src/store/persistence-codecs.ts` and
  `src/store/persistence-load.ts` owns the desktop-local restore path, and
  `src/components/sidebar/SidebarProjectsSection.tsx` plus `src/components/SidebarFooter.tsx` only
  render and toggle those section states; collapsed secondary sections may stay compact, but the
  footer still needs to surface peer-session identity cues without requiring an explicit expand
- `src/components/TaskPanel.tsx` now keeps section composition and task-local refs while
  `src/components/task-panel/task-panel-focus-runtime.ts`,
  `src/components/task-panel/task-panel-preview-controller.ts`,
  `src/components/task-panel/task-panel-dialog-state.ts`, and
  `src/components/task-panel/task-panel-permission-controller.ts` own the reusable focus, preview,
  dialog, and permission-flow orchestration seams. The permission controller delegates command
  response work to `src/app/task-permission-workflows.ts` instead of resolving it inline.
- task/project workflow entry points now live in app owners:
  `src/app/project-workflows.ts` owns project picking/removal sequencing, while
  `src/app/new-task-dialog-workflows.ts` owns the "open new task dialog" policy and keeps
  `src/store/navigation.ts` focused on pure dialog state toggles
- `src/components/ReviewPanel.tsx` now keeps rendering, selection, and review-surface composition
  while `src/components/review-panel/review-panel-controller.ts` owns the loading/diff request
  orchestration behind it. The shared review-session owner still lives in
  `src/components/review-surface-session.ts`
- `src/components/terminal-view/terminal-session.ts` stays the public terminal lifecycle facade
  while `src/components/terminal-view/terminal-input-pipeline.ts`,
  `src/components/terminal-view/terminal-output-pipeline.ts`, and
  `src/components/terminal-view/terminal-recovery-runtime.ts` own the input, output, and recovery
  sub-lifecycles behind it

### 2. Runtime Adapter Layer

Files:

- `src/app/desktop-session.ts`
- `src/app/desktop-session-startup.ts`
- `src/app/desktop-browser-runtime.ts`
- `src/app/desktop-session-types.ts`
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
- publish browser-session presence and identity to the control plane
- prioritize active terminal attach over background attach
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
- peer presence snapshots
- task takeover request/result sequencing
- control-event sequencing
- controller lease behavior

This is the cleanest part of the current architecture. The transport rules are more centralized, better typed, and better tested than they were before.

### 4. Workflow / Use-Case Layer

Files:

- `src/app/task-workflows.ts`
- `src/app/task-lifecycle-workflows.ts`
- `src/app/task-prompt-workflows.ts`
- `src/app/task-shell-workflows.ts`
- `src/app/task-convergence.ts`
- `src/app/remote-access.ts`
- `src/domain/task-closing.ts`
- `electron/ipc/task-workflows.ts`
- `electron/ipc/git-status-workflows.ts`
- `electron/ipc/remote-access-workflows.ts`
- `src/app/task-ai-workflows.ts`
- `src/app/task-close-state.ts`
- `src/app/task-output-channels.ts`
- `src/app/task-command-lease-session.ts`
- `src/app/task-command-lease-runtime.ts`
- `src/app/task-command-lease-runtime-state.ts`
- `src/app/task-command-lease-runtime-subscriptions.ts`
- `src/app/task-command-lease-takeover.ts`

Responsibilities:

- own multi-step user-facing operations
- sequence backend mutations plus side effects
- centralize refresh, watcher, and reconciliation behavior
- project backend-owned state like remote access and task attention into UI-facing models
- derive review-ready, stale, and overlap-aware convergence state from canonical git data
- keep transport adapters and handlers thin

This layer is newer than the others, but it is now a real part of the architecture. It is the main answer to the earlier problem where end-to-end behavior was scattered across handlers, services, store slices, and runtime shells.

One workflow split worth calling out explicitly now:

- `src/app/task-command-lease-session.ts` owns the public task-command lease API and retained
  session behavior
- `src/app/task-command-lease-runtime.ts` is the public runtime facade for lease acquisition and
  release behavior
- `src/app/task-command-lease-runtime-state.ts` owns local retained-lease maps and invalidator
  bookkeeping
- `src/app/task-command-lease-runtime-subscriptions.ts` owns controller/transport subscriptions,
  takeover-expiry cleanup, and transport-generation invalidation
- `src/app/task-command-lease-takeover.ts` owns pending takeover decisions and prompt/response
  policy

That split exists so takeover policy, retained-session lifecycle, and transport/runtime cleanup do
not regress one another inside a single file.

### 5. Application State / Projection Layer

Files:

- `src/store/core.ts`
- `src/store/state.ts`
- `src/store/store.ts`
- `src/store/tasks.ts`
- `src/store/agents.ts`
- `src/store/taskStatus.ts`
- `src/store/agent-output-activity.ts`
- `src/store/agent-ready-callbacks.ts`
- `src/store/agent-question-state.ts`
- `src/store/task-git-status.ts`
- `src/store/task-command-takeovers.ts`
- `src/store/keyed-snapshot-record.ts`
- `src/store/projects.ts`
- `src/store/remote.ts`
- `src/store/persistence.ts`
- `src/store/persistence-codecs.ts`
- `src/store/persistence-save.ts`
- `src/store/persistence-load.ts`
- `src/store/persistence-load-context.ts`
- `src/store/persistence-legacy-state.ts`
- `src/store/persistence-agent-defaults.ts`
- `src/store/persistence-projects.ts`
- `src/store/persistence-task-hydration.ts`
- `src/store/persistence-terminal-restore.ts`
- `src/store/persistence-session.ts`
- `src/store/task-state-cleanup.ts`
- `src/store/types.ts`

Responsibilities:

- hold the client-side source of truth for UI state
- expose mutations and selectors
- own persistence loading/saving logic
- project ephemeral browser presence and takeover request state
- derive task/agent status for presentation

This layer is cleaner than it was, but it is still not "just state". Some store modules still act as a workflow facade, especially around task and agent behavior.
The current direction is to remove workflow entrypoints from store modules where possible, keep
`src/store/navigation.ts` and similar files as pure local state mutation owners, and move
multi-step behavior into `src/app/*` workflow modules. The current intentional exceptions are
`src/store/auto-trust.ts`, which still owns a narrow lease-driven control path, and
`src/store/taskStatus.ts`, which fronts the task-presentation projection helpers.

One non-obvious boundary inside this layer now matters in review:

- `src/store/core.ts` is the internal primitive store implementation
- `src/store/state.ts` is the sanctioned primitive facade for owner modules that really do need
  direct store reads/writes
- `src/store/store.ts` remains the broader public selector/action barrel for component-facing
  consumers

That split exists to keep `store/core.ts` out of app/runtime/component code without forcing
everything through the full public barrel and creating import cycles. App and runtime owners should
prefer `src/store/state.ts` or the narrow store authority they actually need instead of importing
the broad `src/store/store.ts` barrel.

Another projection boundary that now matters in review:

- `src/store/focus.ts` owns raw `focusedPanel` normalization and selector policy

App, runtime, and presentation code should read focused-panel state through the named selectors
instead of interpreting `store.focusedPanel` directly.
Late focus for panels that register after startup also belongs here: terminal/session code may
publish a focus callback, but `src/store/focus.ts` decides whether a still-current pending panel
focus should replay once that callback exists. Presentation code should not call `term.focus()` as
its own startup policy.

The same rule now applies to incoming desktop takeover prompts:

- `src/store/task-command-takeovers.ts` owns incoming takeover request ordering and lookup

Desktop UI should consume the named request selectors instead of sorting
`store.incomingTaskTakeoverRequests` inline.

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

The closed-domain metadata for review state now lives with that domain:

- `src/domain/task-convergence.ts` owns labels, queue grouping, queue ordering, and review-state
  tone metadata
- `src/components/task-review-presentation.ts` translates those shared tone decisions into theme
  colors for desktop presentation

This keeps queue policy, sidebar badges, and review panel summary color/label behavior aligned when
new review states are added.

Another small but important shared workflow boundary is task closing:

- `src/domain/task-closing.ts`

It centralizes task and terminal closing predicates so workflow modules and screens stop spreading
raw close-state checks and direct-mode guards independently.

Tasks now carry a discriminated `closeState` object instead of a loose `closingStatus` /
`closingError` pair. Terminals still use the simpler `closingStatus` field because they only need
`closing` versus `removing`.

Another store-owned cleanup seam worth preserving:

- `src/store/task-state-cleanup.ts`

Task removal and incremental workspace reconciliation now use the same task-scoped cleanup helpers
for derived state, agent records, and panel-side state instead of maintaining parallel delete
clusters.

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

## Shared Workspace State Vs Client Session State

The browser and Electron shells now distinguish between five different ownership modes instead of
persisting one shared UI blob:

- `WorkspaceSharedState`
  - durable workspace-scoped state shared across clients
  - examples: projects, task order, collapsed task state, task notes, task metadata
- `ClientSessionState`
  - browser-local or window-local session state
  - examples: selected task, selected agent, sidebar and focus state, panel sizes, font/theme preferences
- `PeerPresence`
  - live browser-session identity and focus/control context
  - examples: display name, active task, focused surface, visibility, currently controlled tasks
- takeover requests
  - short-lived control-plane request/response state
  - examples: incoming takeover cards, pending requester state, timeout-driven result messages
- task command control
  - short-lived task-scoped control leases for high-conflict task actions
  - examples: prompt dispatch, merge, push, close, collapse, restore

This split matters for multi-client behavior:

1. foreign shared-workspace updates should not overwrite local selection or view state
2. reconnect should restore shared workspace state and active task command controllers explicitly
3. conflicting task mutations should use typed control leases instead of silent last-write-wins races

Relevant files:

- `src/store/persistence.ts`
- `src/store/client-session.ts`
- `src/domain/presence.ts`
- `src/runtime/browser-presence.ts`
- `src/domain/presence-runtime.ts`
- `src/store/peer-presence.ts`
- `src/store/task-command-controllers.ts`
- `src/domain/task-command-controller-projection.ts`
- `src/domain/task-command-owner-status.ts`
- `src/store/task-command-takeovers.ts`
- `src/runtime/browser-state-sync-controller.ts`
- `src/runtime/browser-session.ts`
- `electron/ipc/system-handlers.ts`
- `electron/ipc/task-command-leases.ts`
- `src/app/task-command-lease.ts`

One ownership boundary matters here in review:

- `src/domain/presence.ts` owns the shared connection-status and `update-presence` payload types
- `src/domain/presence-runtime.ts` owns the DOM/reactive heartbeat runtime built on top of those
  shared domain types

That split keeps websocket/server typing out of DOM-bearing runtime modules while preserving one
canonical presence contract across browser desktop, remote/mobile, and the backend control plane.

## Peer Presence, Ownership, And Takeover Flow

Browser desktop and remote/mobile now share the same backend task-command control model. The UI
projections are still different, but ownership truth, takeover sequencing, and controller versioning
are no longer desktop-only concerns.

### Presence

- `src/runtime/browser-presence.ts` publishes the current browser session's:
  - display name
  - visibility
  - active task
  - focused surface
  - currently controlled tasks
- `server/browser-control-plane.ts` tracks those snapshots per authenticated browser client and
  fans out the authoritative presence list through `server/browser-peer-presence.ts`
- `src/app/server-state-bootstrap.ts` and `src/runtime/browser-session.ts` replay presence on
  startup and reconnect
- `src/store/peer-presence.ts` projects that snapshot list into UI-friendly selectors
- UI surfaces like `src/components/SidebarFooter.tsx`, `src/components/TaskTitleBar.tsx`, and the
  terminal/prompt control affordances render those projections
- `src/remote/remote-presence.ts` publishes the remote/mobile session's:
  - display name
  - visibility
  - active task
  - focused surface
  - currently controlled tasks
- `src/remote/remote-collaboration.ts` projects peer presence, controller snapshots, and incoming
  takeover requests for the remote shell
- remote/mobile now uses the same display-name and control cues as desktop, but through its smaller
  agent-centric projection layer instead of the full desktop store

### Takeover

- task control itself is still enforced by backend task-command leases
- browser takeover request queuing, timeout, and controller-change reconciliation now live behind
  `server/browser-task-command-takeovers.ts`, while `server/browser-control-plane.ts` stays the
  composition root that wires the backend owner into transport events
- browser sessions use `src/app/task-command-lease.ts` to request takeover rather than silently
  stealing control
- the browser control plane brokers request/result messages
- the current owner sees stacked takeover request cards through
  `src/components/TaskTakeoverRequestDialog.tsx`
- the requester sees pending, approved, denied, forced, or timed-out outcomes projected through the
  same store/runtime path
- remote/mobile uses:
  - `src/remote/remote-task-command.ts` as the public task-command control facade
  - `src/remote/remote-task-command-state.ts` for retained-lease, pending-takeover, and queued-write state
  - `src/remote/remote-task-command-subscriptions.ts` for controller/transport subscriptions, transport invalidation, and takeover request lifecycle
  - `src/remote/remote-ipc.ts` for task-command lease HTTP IPC
  - `src/remote/ws.ts` for sequenced controller, takeover, and presence events
  - `src/remote/RemoteTaskTakeoverDialog.tsx` for the owner-side approve / deny surface, which
    renders the full pending request queue rather than truncating to the earliest request
- remote/mobile input and resize now follow the same task-command control lifecycle as desktop
  instead of sending raw terminal writes without ownership
- browser session naming is still App-owned on desktop/browser mode; the browser-only header action
  in `src/components/Sidebar.tsx` reopens `src/components/DisplayNameDialog.tsx` through the shared
  action registry instead of leaf chrome owning a parallel dialog state

Important property:

- leaf dialogs and banners render takeover state
- the control plane and task-command lease owners decide whether control actually moves
- task-command controller snapshots are backend-versioned so a stale HTTP/IPC lease response cannot
  overwrite a newer websocket/control-plane ownership change in the renderer
- desktop and remote/mobile now share the same controller snapshot ordering and owner-status
  derivation through domain helpers instead of maintaining separate projection logic

## Terminal Attach And Restore UX

Terminal attach is no longer a pure "mount means attach immediately" path.

Relevant files:

- `src/app/terminal-attach-scheduler.ts`
- `src/app/terminal-output-scheduler.ts`
- `src/store/terminal-startup.ts`
- `src/components/TerminalStartupChip.tsx`
- `src/components/SidebarTaskRow.tsx`
- `src/components/TerminalView.tsx`
- `src/components/terminal-view/terminal-session.ts`
- `src/components/terminal-view/terminal-input-pipeline.ts`
- `src/components/terminal-view/terminal-output-pipeline.ts`
- `src/components/terminal-view/terminal-recovery-runtime.ts`
- `src/lib/terminalFitLifecycle.ts`
- `src/lib/terminal-output-priority.ts`
- `src/lib/webglPool.ts`

Current shape:

1. `TerminalView` registers with the attach scheduler instead of always attaching immediately
2. the scheduler gives priority to the active task and focused terminal before background terminals
3. attach scheduler slots are released as soon as spawn/channel bind completes, so expensive replay
   no longer blocks the next queued terminal from starting its own bind
4. terminals show explicit `Connecting`, `Attaching`, and `Restoring` states while the attach path
   is still stabilizing
5. initial attach and reconnect recovery both go through the shared `GetTerminalRecoveryBatch`
   coalescing path, while each terminal still keeps its own live-output pause/resume guard until
   replay settles
6. replay throughput is tuned separately from attach scheduling: current restore chunk sizes are
   `256 KiB` for focused and active-visible terminals, `128 KiB` for visible-background terminals,
   and `64 KiB` for hidden terminals because phase-traced browser-lab measurements showed that this
   mixed profile improved full-terminal completion while larger hidden-only/background-only jumps
   regressed or stalled startup
7. fit/restore readiness is explicit before queued output is flushed into xterm
8. once attached, terminal output is drained through a shared runtime scheduler instead of each
   terminal independently racing its own frame/timer path
9. WebGL priority is driven by focus and visibility, not by raw output volume
10. queued/background terminal startup now has a shared renderer-side activity owner in
    `src/store/terminal-startup.ts`, so the app can show one subtle aggregate startup indicator and
    compact per-task sidebar hints without each `TerminalView` inventing its own global status view
11. the public terminal lifecycle now stays visible in `terminal-session.ts`, while input dispatch,
    output/write flow control, and recovery/rebind behavior live behind the named terminal-view
    owners instead of re-accumulating in one file

Important property:

- this improves perceived startup speed without changing backend throughput rules
- global startup visibility is intentionally separate from backend-owned task attention; local
  attach/restore progress belongs to the renderer-side startup owner, not to
  `src/app/task-presentation-status.ts`
- it is intentionally still separate from PTY resize authority, which remains a follow-up gap

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
- `src/app/task-presentation-status.ts` combines supervision, lifecycle, and git readiness into a canonical task presentation model
- `src/components/SidebarTaskRow.tsx` renders the compact sidebar attention and review signals inline with each task row

This is intentionally separate from raw task/agent dot status derivation. Attention and review are richer task supervision concepts, but they now surface through the same compact task-list UI instead of separate top-level queue panels.

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
- explicit resume strategy
- current status
- exit information
- last output tail
- generation/restart identity

Status is partly authoritative from the backend and partly interpreted on the frontend.

One non-obvious ownership rule matters here now:

- agent definitions declare `resume_strategy`
- CLI-style agents resume through launch arguments
- Hydra resumes through backend-owned startup recovery in the vendored operator runtime
- renderer code may request a resumed spawn, but it must not recreate Hydra's `:resume` workflow or
  special-case Hydra boot timing locally

That split exists because persisted workspace state can outlive backend PTY sessions. After a server
restart, the first attach still owns the real recovery decision. For Hydra, that recovery is now
worktree-scoped and serialized in the backend/vendored runtime instead of being approximated in the
renderer.

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
- remote/mobile still receives the agent-focused stream:
  - `agents`
  - `status`
  - `output`
  - `scrollback`
- remote/mobile also now participates in the shared collaboration/control stream:
  - `peer-presences`
  - `state-bootstrap`
  - `task-command-takeover-request`
  - `task-command-takeover-result`
  - `ipc-event` controller updates
  - both `src/remote/ws.ts` and `src/remote/remote-collaboration.ts` now classify handled versus
    intentionally ignored live messages explicitly so remote scope drift is visible in code review
  - the remote live `ipc-event` channel set is shared in
    `src/domain/remote-live-ipc-events.ts` so server emitters and remote consumers stay aligned

This runtime is still simpler than browser desktop, but it is no longer just a read-mostly shell. It
shares session naming, presence, ownership, and takeover behavior with desktop while keeping its
own agent-centric UI model.

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
6. `src/remote/remote-presence.ts` publishes remote/mobile display name, focus, visibility, and
   current control state
7. `src/remote/remote-collaboration.ts` applies:
   - peer presence
   - controller snapshots
   - takeover requests/results
8. `src/remote/remote-task-command.ts` uses:
   - HTTP IPC lease requests for acquire / renew / release / resize / write
   - websocket control messages for takeover request / response
9. the remote UI receives both terminal data and collaboration state, then projects them into:
   - agent cards and previews
   - ownership chips and read-only states
   - takeover dialogs and result notices

Important property:

- remote/mobile is not "the desktop UI in a smaller layout"
- it is a separate agent-view application sharing backend services, transport rules, and task-command
  control semantics

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
6. `src/components/PreviewPanel.tsx` is the canonical preview and port-management surface:
   - it shows exposed preview ports
   - it merges live scan candidates with advisory output-detected ports
   - it makes the “detected from output” fallback explicit when no current listener scan succeeds
   - it lets the user expose, retry, or unexpose ports without switching into a separate modal flow
7. browser mode opens exposed ports through `/_preview/:taskId/:port/*`

Important properties:

- detection is advisory
- exposure is explicit
- preview state is replayable after reconnect
- task deletion clears task-port state
- opening preview is snapshot-first; the controller renders current task-port truth immediately and
  expensive candidate scans stay behind explicit rescan policy

### 5. Terminal Output Flow

Electron mode:

1. `electron/ipc/pty.ts` receives PTY bytes
2. output is batched and forwarded through the Electron channel bridge
3. `src/components/TerminalView.tsx` writes output into xterm
4. `src/store/taskStatus.ts` fronts the output-activity owners:
   - `src/store/agent-output-activity.ts`
   - `src/store/agent-ready-callbacks.ts`
   - `src/store/agent-question-state.ts`
5. those owners observe recent output tails and update question/prompt state

Browser mode:

1. `electron/ipc/pty.ts` emits output to a browser-mode channel callback
2. `server/browser-channels.ts` packages output via `server/channel-frames.ts`
3. per-client/per-channel fanout and backpressure rules are applied
4. channel frames are sent over websocket
5. `src/lib/ipc.ts` routes channel payloads to terminal listeners
6. `src/app/terminal-output-scheduler.ts` chooses which terminals get render budget first
7. `src/components/terminal-view/terminal-session.ts` keeps the transport-aware session lifecycle,
   while `src/components/terminal-view/terminal-output-pipeline.ts` writes output into xterm under
   that scheduler and `src/components/TerminalView.tsx` projects focus/visibility priority into it
8. status/prompt detection runs in the frontend with slower background cadence

Important property:

- terminal output is the most performance-sensitive path
- it cuts across PTY, server shell, transport, and UI
- that is why this area still resists aggressive abstraction
- noisy background terminals should not be able to keep themselves hot purely by repaint volume
- focused terminals may still fast-path small plain output, but redraw-heavy control bursts should
  be paced so the UI does not expose every intermediate repaint frame
- that pacing works on raw bytes and must not invent terminal semantics: transport chunks are not
  ANSI boundaries, and the renderer still writes the original bytes to xterm unchanged

### 6. Scrollback Recovery and Rebind Flow

Browser mode only:

1. terminals bind a channel over websocket
2. if the socket drops, the server may retain channel backlog briefly
3. if backlog is too old or too large, the server marks the channel `RecoveryRequired`
4. `src/components/terminal-view/terminal-session.ts` delegates batched terminal recovery to
   `src/components/terminal-view/terminal-recovery-runtime.ts`, which requests recovery through
   `src/lib/scrollbackRestore.ts`
5. browser IPC uses `get_terminal_recovery_batch` over HTTP IPC to fetch a backend-owned recovery result:
   - request state includes both the last applied `outputCursor` and the retained rendered tail
   - backend prefers cursor-based delta when the requested cursor is still within the retained window
   - rendered-tail overlap is the fallback delta path when cursor continuity is unavailable
   - `noop`
   - `delta`
   - `snapshot`
6. the terminal applies the lightest valid recovery and resumes live output

Important property:

- browser recovery is now explicit catch-up, not implicit live replay of historical output
- `delta` and `noop` recovery should stay non-blocking in the renderer; only snapshot fallback should surface a blocking restore state
- destructive reset is a fallback for irreconcilable snapshots, not the default recovery path
- large-history terminals should stay stable under reconnect, backpressure recovery, and rebind

For the practical testing and debugging workflow around this area, including which browser-lab
helpers to use and which lifecycle signals to trust, see
[TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md).

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
- the protocol and lifecycle derivation are now shared
- task-dot and attention semantics are canonicalized through `src/app/task-presentation-status.ts`
- local prompt detection still exists in the renderer, but only for terminal-local UX and one-shot prompt affordances

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
- `src/store/task-git-status.ts`
- `src/runtime/server-sync.ts`

Current shape:

- browser mode prefers server-owned push and replay for git state and convergence state
- Electron mode still has some targeted on-demand refresh paths, but review and convergence ownership are no longer client-derived

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
   - pushed git state updates remain primary
   - some advanced UI surfaces still use targeted on-demand refresh
6. `src/store/task-git-status.ts` and `src/runtime/server-sync.ts` map pushed browser events into
   store updates

Important property:

- browser mode now has a clear canonical path: backend owns git state, server pushes and replays it
- Electron mode is much closer to the same ownership model for git and convergence state
- the main remaining asymmetry is startup/restore contract alignment and a few advanced on-demand UI reads
- task-bound destructive dialogs consume `src/store/task-git-status.ts` through shared selectors and
  refresh helpers; they do not fetch worktree status directly from dialog-local transport code

### 9A. Review Diff Flow

Files:

- `electron/ipc/git-diff-ops.ts`
- `electron/ipc/task-git-handlers.ts`
- `src/app/review-diffs.ts`
- `src/app/review-files.ts`
- `src/components/review-panel/review-panel-controller.ts`
- `src/components/ReviewPanel.tsx`
- `src/components/ScrollingDiffView.tsx`

Current shape:

- backend owns changed-file enumeration and per-file diff semantics for both review and non-review
  surfaces
- `src/app/review-diffs.ts` is only a routing seam between review surfaces and the typed backend
  IPC channels
- review surfaces pass the actual `ChangedFile` metadata into that seam, so the backend can take
  status-aware fast paths without re-deriving file intent in the renderer
- `src/components/ChangedFilesList.tsx` has explicit `task` and `worktree` modes:
  - task-bound surfaces read pushed task review snapshots
  - generic worktree surfaces own branch-fallback and worktree-revalidation policy without
    regrowing backend truth in dialogs or leaf components

Flow:

1. `electron/ipc/git-diff-ops.ts` computes changed files from 3 backend-owned sources:
   - committed branch delta via `git diff --raw --numstat <mergeBase> <head>`
   - tracked worktree delta via `git diff --raw --numstat HEAD`
   - untracked files via `git ls-files --others --exclude-standard`
2. the backend supplements that split with `git ls-files -u` so merge-conflict paths keep `U`
   status instead of collapsing to `M`
3. review and non-review file lists consume the same changed-file metadata, while presentation-only
   helpers like `src/lib/changed-file-display.ts` stay renderer-local
4. per-file diff requests flow through `src/app/review-diffs.ts`, which routes committed files to
   branch diff IPC and worktree files to worktree diff IPC
5. `electron/ipc/git-diff-ops.ts` uses status-aware fast paths:
   - untracked or added files synthesize text diffs without unnecessary history probes
   - modified files load `git diff HEAD -- <file>`, `git show HEAD:<file>`, and disk content in
     parallel
   - deleted files load only the worktree diff plus the `HEAD` blob
6. repeat selections are served through a narrow backend diff cache keyed by repo path, revision,
   file path, status, and disk fingerprint

Important property:

- review mode does not own its own diff heuristics
- non-review and review surfaces share the same backend truth for `diff`, `oldContent`, and
  `newContent`
- the main performance lever is backend subprocess fan-out, not renderer-side reinterpretation
- sibling task surfaces should stay on one canonical changed-file path; if a surface looks
  task-bound, it should consume task-bound review or git-status projections instead of choosing an
  ad hoc local fetch path

### 10. Persistence and Reconciliation Flow

Files:

- `src/store/persistence.ts`
- `src/store/persistence-save.ts`
- `src/store/persistence-load.ts`
- `src/store/persistence-codecs.ts`
- `src/store/persistence-session.ts`
- `electron/ipc/storage.ts`
- `src/runtime/server-sync.ts`
- `src/runtime/window-session.ts`

Flow:

1. the frontend periodically saves app state
2. backend storage persists it
3. on startup, saved state is loaded back into the store
4. runtime reconciliation then checks live backend state against loaded store state
5. missing agents are marked exited and notifications may be shown

Non-obvious current rule:

- full-state loads and workspace-state loads now reuse the same canonical project and task hydration
  helpers instead of maintaining parallel ad hoc parsing paths in `src/store/persistence.ts`

Important property:

- persisted state is not considered fully authoritative
- runtime reconciliation is a second pass that repairs persisted assumptions using live backend data
- `src/store/persistence.ts` is now a thin facade; save, load/reconcile, codec, and sync-session
  changes should stay in their dedicated owners instead of re-accumulating in one file

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
3. browser mode replays remote-access status through the browser control plane
4. the frontend store keeps remote-access status separate from browser peer-presence snapshots
5. UI components render availability and any connected-client counts without making remote-access
   the owner of collaboration state

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
- browser control-plane composition in:
  - `server/browser-control-plane.ts`
  - `server/browser-control-delayed-sends.ts`
  - `server/browser-peer-presence.ts`
  - `server/browser-task-command-takeovers.ts`
- backend workflow modules in:
  - `electron/ipc/task-workflows.ts`
  - `electron/ipc/git-status-workflows.ts`
  - `electron/ipc/remote-access-workflows.ts`
- terminal-view lifecycle composition in:
  - `src/components/terminal-view/terminal-session.ts`
  - `src/components/terminal-view/terminal-input-pipeline.ts`
  - `src/components/terminal-view/terminal-output-pipeline.ts`
  - `src/components/terminal-view/terminal-recovery-runtime.ts`
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
- review and convergence state are now backend-owned, pushed, and replayed
- task-dot, attention, and focus semantics now come from one canonical presentation mapper
- remote-access status now uses a clearer enabled/disabled contract

Still mixed:

- Electron git delivery still includes some targeted on-demand refresh in advanced UI surfaces
- browser replay and Electron startup hydration still restore the same state through different mechanisms
- remote presence semantics are aligned in shape, but not fully identical in meaning across runtimes
- resize authority is not yet fully backend-authoritative for shared browser terminals
- full-screen and alt-screen TUI restore still falls back to heavier redraw paths than ideal

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
- backend convergence snapshots
- task presentation mapping

Still weak:

- remote presence semantics across runtimes
- startup/restore state-category alignment between browser replay and Electron hydration

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

That now includes an explicit latency policy for browser typing:

- control keys such as Enter and Ctrl+C flush immediately
- isolated single-key interactive input prefers an idle fast path instead of sitting behind the
  old 4-8ms browser batch delay
- short interactive bursts still use a tiny batch window instead of sending every key blindly
- large paste or bulk input stays on the bounded batching path
- the renderer does not own lease truth; it only asks the task-command lease session whether a
  retained lease is still hot
- the PTY service mirrors the same split:
  - interactive input drains on `setImmediate`
  - bulk input keeps the short timed batch
- browser output pacing is also explicit:
  - small plain focused output may still use the immediate path
  - redraw-heavy control bursts are coalesced briefly instead of surfacing each intermediate frame
  - that policy is pacing only; it does not strip control bytes or move terminal truth out of the
    backend
- `IPC.WriteToAgent` is the one invoke channel with a targeted clone fast path because it is the
  terminal hot path and its payload is already a narrow string shape

Important property:

- latency tuning stays explicit at the workflow, transport, and PTY boundaries
- no speculative local echo or renderer-owned terminal truth was added
- paste, replay, and heavy-output behavior remain different policies from interactive typing

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
- Playwright browser-lab coverage now exercises authenticated browser startup, fixture-driven terminal
  rendering, reload/restore, and representative multi-client takeover flows in a real browser

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

## Guardrails

Some rules are now treated as architectural guardrails rather than informal conventions:

### Runtime composition guardrails

1. replayable server-owned state categories must register through the shared bootstrap registry
2. `desktop-session.ts` must not add ad hoc startup listeners for server-owned state
3. `browser-control-plane.ts` must not become a second bootstrap registry or a UI policy layer;
   delayed sends, peer presence, and takeover workflow stay behind their focused backend owners
4. remote bootstrap and remote live-event paths must classify categories explicitly as handled now
   or intentionally ignored now; do not hide drift behind open-ended default branches
5. once a module is split into facade plus focused owners, the facade should stay thin and
   architecture tests should target the real owner file rather than the pass-through shell

### Store and projection guardrails

1. `src/store/core.ts` is the internal primitive store implementation; app, runtime, and
   presentation code should use `src/store/state.ts`, `src/store/store.ts`, or a narrower
   authority module instead
2. `src/app/*` and `src/runtime/*` should not import `src/store/store.ts`; that barrel stays
   component-facing, while app/runtime owners should depend on `src/store/state.ts` or the narrow
   store authority they actually need
3. controller consumers should read through controller selectors rather than reaching into the raw
   controller map
4. focused-panel consumers should read through focus selectors instead of reinterpreting the raw
   `focusedPanel` map locally
5. task close lifecycle must stay on the discriminated `Task.closeState` model rather than
   reintroducing loose `closingStatus` or `closingError` fields
6. task removal and workspace reconciliation must share the same task-scoped cleanup authority,
   including any related module-local runtime caches
7. controller ordering truth must stay separate from the live controller record so a newer clear
   snapshot still blocks older later arrivals

### Workflow and presentation guardrails

1. review surfaces must keep file-list freshness behind shared review-state adapters and use the
   shared review-surface bootstrap instead of rebuilding review-session/sidebar wiring per surface
2. task-row, attention, and dot presentation must stay behind the canonical task-presentation
   model rather than reading raw supervision or git state inline
3. browser session naming and similar app-owned dialogs stay in the app/workflow owner; leaf chrome
   should reopen them through the shared action registry instead of creating a second owner
4. queued takeover state should stay modeled and rendered as a queue when the owner keeps a queue;
   do not silently collapse it to the first request in a leaf component
5. terminal startup visibility belongs to the shared terminal-startup owner; leaf chrome should not
   reconstruct aggregate startup progress by scanning mounted terminals or raw scheduler internals
6. `App.tsx` keeps shell-level session/bootstrap and dialog policy; `src/components/app-shell/*`
   should stay presentational and reopen workflow behavior through explicit callbacks
7. `TaskPanel.tsx` should stay a section-composition shell; focus runtime, preview workflow, and
   dialog, and permission-flow orchestration belong behind the named task-panel owners instead of
   regrowing inline or in leaf panels
8. `src/components/review-panel/review-panel-controller.ts` should own review loading,
   request-token, and selection orchestration; `ReviewPanel.tsx` should stay focused on rendering
   and light local derivation while shared review-session behavior remains in
   `src/components/review-surface-session.ts`
9. `src/components/terminal-view/terminal-session.ts` stays the public terminal lifecycle facade;
   input dispatch, output/write flow control, and recovery/rebind behavior belong behind the named
   terminal-view owners instead of regrowing inline or drifting into `TerminalView.tsx`
10. sidebar render order, sidebar keyboard order, and sidebar drag-reorder semantics must share the
    same `src/store/sidebar-order.ts` projection family instead of recomputing grouping separately
    in `SidebarTaskList.tsx`, `focus.ts`, and `Sidebar.tsx`
11. task-status notification policy stays behind the shared
    `src/app/task-notification-runtime.ts` owner; provider-specific delivery lives behind the
    Electron IPC seam and the browser notification sink, while `SettingsDialog.tsx` only owns the
    capability-aware preference UI and permission prompt entry point. The persisted notification
    preference is provider-neutral and default-on; browser permission state must be modeled
    separately from the shared preference instead of disabling the setting when permission is still
    `default`
12. review annotation mutation stays behind the shared `src/app/review-session.ts` owner;
    `ReviewCommentCard.tsx` and `ReviewSidebar.tsx` may own local draft/editing state, but they
    should update existing annotations only through `updateAnnotation(...)` instead of inventing
    parallel mutation paths

These rules are backed by architecture tests so future feature work fails early when it starts to drift.

One current example is review UI: `ReviewPanel.tsx`, `DiffViewerDialog.tsx`, and
`PlanViewerDialog.tsx` now share `src/components/review-surface-session.ts` for review-session,
copy/export, and sidebar bootstrap instead of each rebuilding that wiring locally. The review
panel's remaining loading and selection state belongs in
`src/components/review-panel/review-panel-controller.ts`.

## Current Gaps

The architecture is in a better state than the earlier refactor phases assumed. The remaining gaps are narrower and more product-facing.

### 1. Reliability Proof Is Now The Main Gap

Recent hardening work made bootstrap/replay state ownership, review freshness, supervision presentation, and preview trust much more explicit.

What still matters:

- proving reconnect churn, restore overlap, and multi-client browser behavior through scenario tests
- stress-testing long-lived browser sessions and the heavy terminal/replay paths with repeatable diagnostics
- keeping deploy-readiness smoke tests and canary checks as a first-class part of the release bar

### 2. Product-Behavior Coverage Should Keep Growing With The Product

Recent work added direct screen coverage for the highest-churn UI surfaces, which is a major improvement.

What still matters:

- keep adding screen tests when task creation, focus management, terminal UX, or review flows evolve
- add app-level scenario coverage when reconnect, restore, and pushed state behavior become more sophisticated

### 3. Startup And Reconciliation Remain High-Risk Areas

`desktop-session.ts` and persistence now have direct integration tests, but startup remains one of the easiest places for subtle regressions.

Why this matters:

- startup order bugs often look nondeterministic
- stale persisted state can silently corrupt UI assumptions if the tests drift

### 4. A Few Shared Concepts Still Have More Than One Projection

This is much better than before, but still worth watching when future features land:

- remote presence semantics across desktop host mode and browser mode
- startup/restore semantics across browser replay and Electron hydration
- git refresh behavior in advanced or future UI surfaces

### 5. The Terminal Path Is Still Intentionally Complex

That is acceptable, but it means terminal-related feature work should continue to treat:

- PTY behavior
- websocket/channel behavior
- UI recovery behavior

as one reliability-sensitive path, not as isolated modules.

## Next Phases

The next quality phases should build on the current direction instead of changing it.

For deeper follow-up design ideas around terminal transport, multi-client control lifecycle,
restore strategy, and invariant testing, see
[TERMINAL-INFRA-FOLLOW-UPS.md](./TERMINAL-INFRA-FOLLOW-UPS.md).

### Phase 8: Production Confidence And Scenario Coverage

Goal:

- prove the existing design under real browser, reconnect, preview, review, and multi-client conditions

Targets:

- add browser-mode scenario coverage for auth/bootstrap, reconnect, restore overlap, preview replay, and deletion while review/preview is open
- add standalone deploy smoke tests
- keep flake-management and diagnostics around the heavy latency/replay suites explicit instead of ad hoc

### Phase 9: Performance Confidence And Observability

Goal:

- make the system measurable under load, not just architecturally sound on paper

Targets:

- add stronger diagnostics for bootstrap timing, restore cancellation, preview probe failures, and control/backpressure behavior
- stress long-lived browser sessions, multi-client browser mode, and preview/review/supervision interactions
- keep `server/terminal-latency.test.ts` under an explicit flake policy instead of treating failures as anecdotal

### Phase 10: Product Completion On Top Of The Stronger Foundation

Goal:

- finish the supervision/review/preview loop without reopening broad architectural churn

Targets:

- approval / permission center
- post-merge guidance and sibling-refresh/staleness flows
- preview and supervision polish driven by real usage and diagnostics

Why this order:

- the biggest remaining gap is proof and observability, not core architecture shape
- after that, the product can grow on a much more reliable foundation without relaunching another broad refactor campaign

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
