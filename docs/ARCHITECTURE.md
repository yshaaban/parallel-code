# Architecture Walkthrough

Read [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) first if you are deciding where code should live or whether a change is aligned with the repo direction. Read [PRODUCT-VALIDATION-OBJECTIVES.md](./PRODUCT-VALIDATION-OBJECTIVES.md) when you are deciding which user frustration a change protects and how much proof it needs. Read [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) when you are porting changes from upstream or explaining why a direct cherry-pick is not appropriate.
For the practical contributor workflow around browser terminals, restore, browser-lab validation,
and non-obvious terminal lifecycle rules, read
[TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md).
For the durable terminal behavior contract covering byte fidelity, stream messages, recovery,
readiness, flow control, parity, and degraded platform behavior, read
[TERMINAL-CONTRACT.md](./TERMINAL-CONTRACT.md).
For task/worktree-scoped Docker Compose support, inspect semantics, and lifecycle boundaries, read
[TASK-CONTAINER-ENVIRONMENTS.md](./TASK-CONTAINER-ENVIRONMENTS.md).
For the current explicit git-isolation model, migration rules, and remaining compatibility cleanup, read
[GIT-ISOLATION-MODEL-SPEC.md](./GIT-ISOLATION-MODEL-SPEC.md).
For the browser-first startup contract and the split between cold bootstrap and reconnect restore,
read [BROWSER-BOOTSTRAP-REDESIGN.md](./BROWSER-BOOTSTRAP-REDESIGN.md).
For browser-server coordinator mode, hidden subtasks, tool credentials, and prompt-delivery
ownership, read [COORDINATOR-MODE.md](./COORDINATOR-MODE.md).

This document explains the current Parallel Code architecture after the recent browser control,
multi-client, terminal-attach, and browser-lab work.

It is a runtime map, not a design manifesto. It covers:

1. what the system is
2. how data actually flows today
3. which layers are reasonably clean
4. where the architecture is still mixed or awkward

Use this as the reference point for current runtime structure and data flow. Use the principles
document as the normative guide for ownership, layering, and do/don't rules.

This document owns:

- the current runtime shape
- the current data and control flows
- layer and owner boundaries as they exist today
- the parts of the system that are still mixed or awkward

This document does not own:

- validation policy and quality gates
- terminal/browser-lab runbooks
- review checklists or lessons-learned heuristics

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

Parallel Code has one shared agent/task core with three runtime shells:

1. Electron desktop shell
2. Browser desktop shell
3. Remote/mobile shell

All three shells operate on the same underlying concepts:

- a `Project` is a repo/worktree root plus defaults; `Project.projectMode` explicitly distinguishes
  git projects from non-git projects when git-owned workflows are unavailable
- `Project.containerConfig` is optional repo-scoped configuration for task-owned container
  environments; it is durable project truth, not live runtime state
- a `Task` is the user-facing unit of work and has an explicit execution mode:
  `taskMode: 'agent'` owns one or more AI-agent runtimes, while `taskMode: 'terminal'` owns
  project-backed shell runtimes without an AI agent. Missing persisted modes migrate to `agent`;
  an empty `agentIds` array is never used to infer the mode because collapsed agent tasks are empty
- an `Agent` is the long-lived PTY-backed AI worker attached to an agent-mode task
- `AgentSupervision` is the backend-owned supervision snapshot used for attention routing
- `TaskConvergence` is the app-level projection used for review readiness, overlap, and convergence queueing
- `Coordinator` is the browser-server-only backend owner for orchestration runs, hidden subtasks,
  prompt delivery, startup assignment contracts, Codex readiness detection, subtask inspection,
  explicit subtask cleanup, self-landing state, and backend-owned workflow DAG execution,
  including append-only adaptive step mutation, decision-lane workflow actions, execution
  journaling, join-policy fan-in, branch-bundle iteration limits, repo-review proving templates,
  durable subtask launch payloads with explicit stale-run resume and credential rotation,
  backend-owned per-workflow budget enforcement (steps, lanes, retries, wall-clock) with the
  `execution.budget` projection consumed by the rail, operator approval gates for decision-lane
  workflow actions, run pause/unpause admission control, operator lane retry, and compact
  workflow-state projection
- a `Terminal` is a standalone scratch shell panel in the UI. It is distinct from both an AI
  `Agent` and the task-scoped shells owned by a terminal-mode `Task`
- a `Channel` is a transport output stream binding used primarily in browser mode
- `PeerPresence` is ephemeral per-browser-session identity plus focus/control context
- a task takeover request is a live control-plane workflow, not persisted workspace state
- a `ServerMessage` / `ClientMessage` pair is the websocket control vocabulary

The architecture is not a classic clean architecture. The current shape is pragmatic:

- shared protocol and transport primitives
- explicit runtime adapters for Electron, browser desktop, and remote/mobile
- explicit workflow modules for multi-step use cases
- store and UI layers that are moving toward projection and presentation
- thin server shells that should compose, not own, the workflow logic

Recent quality work has made the real seams explicit:

- browser mode now has three explicit transport planes
- backend multi-step operations now have named workflow modules
- server-owned state like browser git status now prefers push and replay over client polling
- supervision and attention state are backend-owned and pushed to clients
- lifecycle-heavy transport code is now typed and tested more aggressively

Agent launch definitions may include a command, args, and a small explicit environment map. The UI
can create one-off custom terminal agents from a direct command line, but spawning remains a backend
PTY responsibility and command availability remains a backend check. `src/lib/direct-command.ts`
parses launch intent, `src/lib/agent-spawn-config.ts` projects `AgentDef.env`, backend availability
resolution stays in `electron/ipc/command-resolver.ts`, and PTY spawn/env filtering stays in the
backend PTY owner.

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

This layer is thinner than it used to be. The main remaining UI hotspots are large screens like
`TaskPanel.tsx` and transport-aware surfaces like `TerminalView.tsx`.

The UI shell now also has a small shared presentation-primitives seam for repeated chrome:

- `src/components/DialogHeader.tsx` owns common dialog title/description/close affordances
- `src/components/InlineNotice.tsx` owns the standard neutral/warning/error/success inline notice
  treatment
- `src/components/SectionLabel.tsx` owns the uppercase muted section-label treatment used across
  dialogs, sidebars, and settings panes
- `src/lib/typography.ts` owns the semantic typography roles shared by the desktop shell and the
  remote/mobile shell, while `src/styles.css` and `src/remote/index.html` define the actual root
  type tokens

Use these when the structure and behavior already match. Do not force context-specific workflow or
state policy into them.

Two current ownership splits matter in review:

- `src/App.tsx` is the desktop shell composition root: it keeps session/bootstrap wiring, root
  dialog policy, and takeover/display-name workflow state, while `src/components/app-shell/*`
  stays presentational shell chrome
- `src/app/app-startup-status.ts` owns the shared startup summary consumed by
  `DisplayNameDialog.tsx` and `TerminalStartupChip.tsx`, while `src/app/desktop-session.ts` and
  `src/app/desktop-session-startup.ts` own the coarse bootstrap/restore lifecycle updates that feed
  it; the required display-name dialog owns that live region while it is open, and the global
  chip resumes once the dialog is gone
- `src/store/local-shell-preferences.ts` owns canonical defaults, resolution, detached snapshots,
  and boundary-specific encoding for the shared renderer-local shell preference shape.
  `src/store/sidebar-section-state.ts` owns the sidebar collapse sub-fragment defaults and
  normalization, while `src/store/sidebar-sections.ts` owns the live store toggle helpers. Browser
  session storage stays in `src/store/client-session.ts`, browser cold-bootstrap resets apply the
  same closed snapshot in `src/store/browser-cold-bootstrap-projection.ts`, the Electron full-state
  storage boundary stays in `src/store/persistence-codecs.ts` and
  `src/store/persistence-load.ts`, and
  `src/components/sidebar/SidebarProjectsSection.tsx` plus `src/components/SidebarFooter.tsx` only
  render and toggle those section states; collapsed secondary sections may stay compact, but the
  footer still needs to surface peer-session identity cues without requiring an explicit expand
- `store.terminalHighLoadMode` is a renderer-local preference, not backend truth. Browser mode
  persists through the store/persistence owners, while `src/app/terminal-high-load-mode.ts` owns
  the runtime-facing mirror consumed by app/runtime modules. App workflow owners should subscribe to
  that mirror instead of importing `store/core` directly, and store writers plus restore paths must
  sync it explicitly. Omitted persisted state must preserve the current bootstrap-backed value
- `src/components/TaskPanel.tsx` now keeps section composition and task-local refs while
  `src/components/task-panel/task-panel-focus-runtime.ts`,
  `src/components/task-panel/task-panel-steps-controller.tsx`,
  `src/components/task-panel/task-panel-preview-controller.ts`,
  `src/components/task-panel/task-panel-dialog-state.ts`, and
  `src/components/task-panel/task-panel-permission-controller.ts` own the reusable focus, preview,
  dialog, and permission-flow orchestration seams. Task-scoped terminal switch-window lifecycle for
  task-panel terminals now lives here as well, so mounted sibling `TerminalView`s only report
  readiness/recovery against the shared task window instead of individually starting or cancelling
  it. The permission controller delegates command response work to
  `src/app/task-permission-workflows.ts` instead of resolving it inline.
- task steps are backend-owned worktree truth. `electron/ipc/task-steps.ts` owns
  `.claude/steps.json` watching, normalization, host-stamped timestamp repair, summary projection,
  and replayable backend events; `electron/ipc/task-steps-handlers.ts` is the typed fetch seam;
  `src/store/task-steps.ts` stores backend snapshots; `src/app/task-steps.ts` owns prompt seeding,
  full-snapshot fetch, next-action prefill, and focus/jump behavior; and
  `src/components/task-panel/TaskStepsSection.tsx` is presentation only behind
  `src/components/task-panel/task-panel-steps-controller.tsx`. Persisted `Task` state carries only
  `stepsTracking`; full step history stays in the worktree file and backend projections rather than
  renderer persistence or client-session state
- task/project workflow entry points now live in app owners:
  `src/app/project-workflows.ts` owns project picking/removal sequencing, while
  `src/app/new-task-dialog-workflows.ts` owns the "open new task dialog" policy and keeps
  `src/store/navigation.ts` focused on pure dialog state toggles
- `src/components/NewTaskDialog.tsx` owns form and DOM interaction state, while
  `src/components/new-task-dialog/task-git-options-controller.ts` owns the form-local Git metadata
  lifecycle: parallel branch and ignored-directory reads, stale-response suppression, independent
  branch retry, selection defaults, and branch-conflict projection. The lifecycle is keyed by
  project identity, not only repository path or Git configuration, because multiple project records
  may reference the same path. Branch retry must not invalidate ignored-directory suggestions;
  those queries have different failure and refresh reasons even though the form presents them
  together. Creation projects the form into one discriminated `TaskLaunch` (`agent` or `terminal`)
  before calling the app workflow, so agent-only prompt, permission, and coordinator fields cannot
  leak into terminal tasks. Git location remains an independent axis: managed worktree, project
  root (`current-branch` internally), or imported existing worktree
- `src/domain/task-mode.ts` owns the canonical task-mode vocabulary and legacy default;
  `src/app/task-lifecycle-workflows.ts` owns creation/collapse/restore mode variation;
  `src/components/TaskPanel.tsx` branches section composition once so terminal tasks never mount AI
  terminal, prompt, permission, or coordinator surfaces. The first terminal-task shell explicitly
  owns task watcher restart after restore; ordinary secondary shells do not restart shared watchers
- project-root admission is backend-owned in `electron/ipc/task-workflows.ts`. The backend resolves
  the Git top-level path, reserves its canonical filesystem identity across checkout and runtime
  registration, and keeps live registrations authoritative over lagging renderer snapshots. This
  makes the invariant independent of renderer project ids and shared by Electron and browser IPC.
  Its saved-state mirror registers existing legacy subdirectory paths under the nearest `.git`
  owner root, while preserving nested worktree roots and missing paths as distinct identities.
  Every renderer `CreateTask` request carries a client-generated operation id; the backend
  single-flights concurrent retries and replays the committed result until that task is removed, so
  an ambiguous browser response cannot duplicate a worktree or strand a project-root registration
- task deletion spans backend cleanup and renderer projection, but the ownership remains explicit
  across both managed-worktree `DeleteTask` and state-removing `CleanupTaskRuntime` routes:
  `electron/ipc/task-workflows.ts` first closes and drains pending agent spawns, then owns
  best-effort runner, runtime, worktree, branch, and container cleanup;
  `src/domain/task-cleanup.ts` owns the typed cleanup-warning result shared by both routes across
  Electron and browser IPC transports;
  `src/app/task-lifecycle-workflows.ts` owns user-facing close sequencing, notification of partial
  cleanup warnings, immediate task removal from renderer state, and best-effort persistence after
  removal. A failed cleanup step may warn the user, but it must not leave the task stuck in a
  transitional UI state once the backend has released the runtime owner state. Docker label cleanup
  on this path has one backend-owned deadline propagated into its subprocesses, so a wedged Docker
  runtime becomes a cleanup warning instead of blocking task deletion indefinitely; an unavailable
  runtime still skips the optional container cleanup without blocking the remaining deletion steps
- task container lifecycle is backend-owned. `electron/ipc/task-containers.ts` and
  `electron/ipc/task-container-identity.ts` own Compose support detection, identity, lifecycle, and
  logs; `electron/ipc/task-container-handlers.ts` is the typed IPC seam;
  `src/app/task-containers.ts` plus
  `src/components/task-panel/task-panel-preview-controller.ts` own the task-level workflow,
  including inspect/log/action sequencing, stale-request suppression, and explicit error-state
  ownership; and `src/components/TaskContainersPanel.tsx` is presentation only. Container
  running/support state is not persisted store truth and must not drift into leaf-component
  inference
- agent runner execution is separate from task-container preview lifecycle.
  `src/domain/agent-runners.ts` owns runner profile/status/identity types,
  `electron/ipc/agent-runner-handlers.ts` owns typed profile validation,
  `electron/ipc/agent-runner-docker.ts` owns Docker CLI preflight, Dockerfile build/run argument
  construction, managed labels, bind-mount policy, and exact-label cleanup, and
  `electron/ipc/task-workflows.ts` owns pending-spawn admission, cancellation, per-agent
  serialization, the global preparation limit, and prepared-launch cleanup. It disposes a prepared
  launch if spawn admission closes or the PTY attaches to an already-created session, and retains a
  failed prepared cleanup owner for retry. Per-agent stop is single-flight and keeps that agent's
  spawn admission closed through pending-spawn drain and runner cleanup; global stop applies the
  same single-flight admission barrier to every agent. Either failed stop retains closed admission
  until an explicit retry confirms successful settlement. Independent PTY, prepared-launch, and
  pending-build cleanup is lazily settled so even a synchronous failure cannot skip a later owner.
  Electron IPC, browser websocket, and remote websocket kill paths all await that same workflow owner.
  `electron/ipc/agent-handlers.ts` is the typed IPC seam;
  it does not own spawn concurrency. `electron/ipc/pty.ts` owns live and terminating session
  identity, normally waits for PTY exit before external cleanup, and retains both a non-exiting PTY
  and failed external cleanup for explicit retry. After bounded TERM/KILL exit waits are exhausted,
  it may attempt external cleanup as a force-stop fallback, but the still-live PTY remains owned
  until an exit is observed. Task deletion and application shutdown close and drain pending spawns,
  then await runner cleanup. Renderer code may configure and present runner state, but it must not
  import Docker
  runtime code or infer Docker truth from settings. Host remains the default runner; Docker
  container execution is opt-in; Docker sandbox and Docker-backed Hydra adapter launches are
  explicitly rejected until they have their own backend owner contract. Dockerfile-built images use
  per-runner tags, cleanup removes only exact-label managed containers, and Docker runner env
  forwarding blocks process-control variables such as `PATH`, `HOME`, `SHELL`, `USER`,
  `NODE_OPTIONS`, and dynamic library injection hooks
- arena competitor readiness is backend-owned. `electron/ipc/arena-competitors.ts` owns command
  availability, auth/env readiness, and quiet-output classification for known competitors;
  `src/arena/command-template.ts` owns the shared direct-executable parser/materializer contract;
  `electron/ipc/system-handlers.ts` is the typed inspect IPC seam; `src/arena/ConfigScreen.tsx`
  renders readiness and gates `Fight!`; and `src/arena/BattleScreen.tsx` consumes the same
  direct-executable model that preflight validated. Shell wrappers and env-prefixed launch strings
  are rejected before `Fight!`, and battle execution must not drift back to `/bin/sh -c`.
  Renderer code must not guess PATH/auth state for local CLI competitors
- `src/components/ReviewPanel.tsx` now keeps rendering, selection, and review-surface composition
  while `src/components/review-panel/review-panel-controller.ts` owns the loading/diff request
  orchestration behind it. The shared review-session owner still lives in
  `src/components/review-surface-session.ts`
- `src/components/terminal-view/terminal-session.ts` stays the public terminal lifecycle facade
  while `src/components/terminal-view/terminal-input-pipeline.ts`,
  `src/components/terminal-view/terminal-output-pipeline.ts`, and
  `src/components/terminal-view/terminal-recovery-runtime.ts` own the input, output, and recovery
  sub-lifecycles behind it. Terminal-specific clipboard image paste is a handler/transport-owned
  Electron capability surfaced through typed IPC, while terminal-session owns the explicit browser
  fallback and the final decision to paste the returned temp-file path. Terminal shortcut policy
  belongs in `src/lib/terminal-shortcuts.ts`; terminal-session consumes that policy for keydown
  sends and non-keydown suppression instead of re-encoding ad hoc key heuristics. Task-scoped
  switch-window protection remains app-owned shared state:
  mounted `TerminalView`s may register participation, but they must not each own cancellation of
  the shared task window. Likewise, selected-task state is not enough to keep a hidden terminal
  render-live; hidden siblings must tier as hidden unless they are actually visible, focused, or
  explicitly protected as the current switch target
- typing-priority truth is app-owned shared state in
  `src/app/terminal-interactivity-governor.ts`. Terminal input, output scheduling, and fit/session
  stabilization must consume that governor instead of each inventing separate "focused-input"
  heuristics. The governor owns when a terminal is in typing-critical mode; downstream owners may
  choose how to yield, but they must not redefine who is latency-critical
- task activity in `src/app/task-presentation-status.ts` is separate from task
  attention. Attention answers "what needs action"; activity answers "what is the task doing right
  now". When multiple terminals disagree, current live output should beat unrelated waiting/startup
  cues, while hard failure and recovery states stay explicit. Short-lived activity cues remain
  app-owned projection state, so they need explicit invalidation and lifecycle ownership instead of
  becoming backend truth or leaf-component heuristics
- renderer-local terminal output flow control still applies while a terminal is render-hibernating:
  suppressed chunks may skip live writes, but `terminal-output-pipeline` must continue accounting
  those bytes toward pause/resume thresholds so noisy hidden terminals cannot bypass renderer-side
  backpressure just because their live renderer is asleep
- task AI terminal layout is task-level presentation state. `src/store/task-terminal-layout.ts`
  derives the visible agent set from selected agent, task agents, and the layout mode
  (`focused`, `split`, `grid`, or `stacked`) instead of persisting a second visibility truth.
  `src/components/task-panel/TaskAiTerminalSection.tsx` renders selected panes as the only command
  target and visible siblings as passive-visible real terminal surfaces. TaskPanel owns the shared
  switch-window lifecycle; mounted sibling terminals only report readiness and must not cancel the
  task-level window independently. Terminal session identity is captured at mount/remount
  boundaries, so stale `onReady` / `onDispose` callbacks from an old agent session must not clear or
  focus the current session. Task-agent membership changes are store-level mutations in
  `src/store/agents.ts`: adding an agent selects it and persists membership best-effort, while
  closing a sibling kills its PTY, clears agent-scoped state, and falls back to a remaining task
  agent without allowing the last AI agent to be removed
- fit/layout correctness is separate from typing priority. `terminal-session` and
  `terminalFitManager` may yield non-critical stabilization while another terminal is typing, but
  they must still allow resize/correctness-critical work through instead of letting latency mode
  create stale geometry bugs
- transitional lifecycle states must remain owner-backed. Browser/runtime/presentation code may
  project `reconnecting`, `restoring`, read-only, or flow-control states, but those projections
  must not outrun the backend/runtime owner that will clear them, and they need deterministic test
  coverage for repeated enter/exit churn rather than one-shot happy paths

### 2. Runtime Adapter Layer

Files:

- `src/app/desktop-session.ts`
- `src/app/desktop-session-startup.ts`
- `src/app/browser-cold-bootstrap.ts`
- `src/app/browser-workspace-cold-start-recovery.ts`
- `src/app/browser-startup.ts`
- `src/app/desktop-browser-runtime.ts`
- `src/app/desktop-session-types.ts`
- `src/domain/browser-cold-bootstrap-projection-builder.ts`
- `src/runtime/browser-session.ts`
- `src/store/browser-cold-bootstrap-projection.ts`
- `src/runtime/server-sync.ts`
- `src/runtime/window-session.ts`
- `src/runtime/drag-drop.ts`
- `src/runtime/app-shortcuts.ts`
- `src/lib/ipc.ts`
- `src/remote/ws.ts`

Responsibilities:

- adapt the UI to Electron mode vs browser mode vs remote/mobile mode
- coordinate desktop startup and teardown ordering
- distinguish browser cold bootstrap from reconnect restore
- manage websocket lifecycle, browser reconnection, connection banners, queueing
- publish browser-session presence and identity to the control plane
- prioritize active terminal attach over background attach
- apply the typed browser cold-bootstrap projection before browser-local client session restore
- manage window lifecycle in Electron mode
- translate transport events into store updates and workflow refreshes

This seam is now central. Runtime wiring is easier to find than it was before the refactor passes.

Browser startup now has an explicit split:

- `src/app/desktop-session-startup.ts` starts
  `src/app/browser-workspace-cold-start-recovery.ts` before window chrome, then keeps ownership of
  payload hydration, browser-local client-session restore, and startup-tier sequencing; the
  recovery owner acquires the dedicated backend payload through the thin
  `src/app/browser-cold-bootstrap.ts` transport adapter and owns cancellable per-attempt deadlines,
  bounded retries, and the backend projection -> same-tab handoff -> canonical workspace fallback
  order. Canonical fallback authority is the persistence-session loaded-snapshot marker, not
  renderer-local panel or project shape. The backend builds the
  typed workspace projection through `src/domain/browser-cold-bootstrap-projection-builder.ts`
  while the renderer applies it through `src/store/browser-cold-bootstrap-projection.ts`
- on the successful backend-projection path, the cold-bootstrap fetch is the only awaited network
  round trip before the selected-task startup tier: app shortcuts register before any startup
  await (handlers no-op on an empty store), the fetch starts before window chrome and runs
  concurrently with the websocket runtime registration, and the payload folds in what used to be
  separate round trips — bounded
  `planContents` (exact persisted `planRelativePath` reads, visible tasks only, count/byte
  capped), `projectPathsExist` (applied through `applyProjectPathExistence` with a delayed
  background `validateProjectPaths` for reconciliation), and agent defs with last-known
  availability
- the speculative selected-terminal attach lifecycle is owned by
  `src/app/speculative-terminal-attach.ts`: startup publishes an intent from
  `peekClientSessionSelection()` (a pure read of the persisted client-session fragment through
  the same parsers `loadClientSessionState` uses) before any network round trip, and must
  confirm or discard it against the restored selection identity before announcing the
  selected-task tier; speculation never writes the store, and v1 ships no prewarm consumer (the
  attach-pipeline item may register one through the resolution callback)
- reconnect restore still lives in `src/runtime/browser-session.ts` and continues to use the
  reconnect snapshot path after authenticated control traffic confirms reconnection; if transport
  churn, auth expiry, or restore failure invalidates that restore, `src/app/browser-startup.ts`
  cancels the reconnect-startup mode instead of leaving stale or falsely completed restore
  diagnostics active
- the full reconnect snapshot is revision-keyed: the client passes its loaded
  `knownWorkspaceRevision` into `GetBrowserReconnectSnapshot`, the server omits both saved-state
  JSON payloads on a match (controllers, generations, and running agents still ride along), and
  `src/runtime/browser-state-sync-controller.ts` treats the payload-free matching snapshot as a
  verified no-change that still runs client-session reconciliation and project-path validation;
  revision 0 is the unversioned legacy fallback (legacy `SaveAppState` mutates the file without a
  revision bump), so the client never claims it as a known revision and the server never skips on
  it — `appStateJson` is the single legacy payload shipped only when no workspace-state file
  exists; the handler-side saved-state cache is revision-keyed with no TTL because every save
  path in the process invalidates it explicitly (hit/miss/invalidation/revision-skip diagnostics
  keep reporting)

This split keeps first browser loads from behaving like restored Electron sessions.

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

This is the most settled part of the current architecture. The transport rules are more
centralized, better typed, and better tested than before.

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

This layer is newer than the others, but it is now part of the architecture. It addresses the
earlier problem where end-to-end behavior was scattered across handlers, services, store slices,
and runtime shells.

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

This layer is cleaner than it was, but it is still not "just state". Some store modules still act
as workflow facades, especially around task and agent behavior.
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

That projection lives above raw git services and below the UI so the sidebar review queue, review
panel summary, and post-merge sibling refreshes all use one model.

The closed-domain metadata for review state now lives with that domain:

- `src/domain/task-convergence.ts` owns labels, queue grouping, queue ordering, and review-state
  tone metadata
- `src/components/task-review-presentation.ts` translates those shared tone decisions into theme
  colors for desktop presentation

This keeps queue policy, sidebar badges, and review panel summary color/label behavior aligned when
new review states are added.

Another shared workflow boundary is task closing:

- `src/domain/task-closing.ts`

It centralizes task and terminal closing predicates so workflow modules and screens stop spreading
raw close-state checks and git-isolation guards independently.

Tasks now carry a discriminated `closeState` object instead of a loose `closingStatus` /
`closingError` pair. Terminals still use the simpler `closingStatus` field because they only need
`closing` versus `removing`.

Another store-owned cleanup seam worth preserving:

- `src/store/task-state-cleanup.ts`

Task removal and incremental workspace reconciliation now use the same task-scoped cleanup helpers
for derived state, agent records, and panel-side state instead of maintaining parallel delete
clusters.

Task and standalone terminal removal should clear renderer state immediately after the owning
runtime cleanup completes and then persist that removal best-effort. Do not reintroduce delayed
store deletion for close animations; a delayed delete can reload stale task or terminal state and
looks like a crash loop when cleanup races with browser persistence.

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

These modules are low-level. They should provide capabilities that workflows and handlers compose
rather than quietly becoming use-case layers themselves.

`electron/ipc/ask-about-code.ts` owns every launched provider process from admission through bounded
tree termination. Cancelling or replacing a request removes only the current request-id projection;
the terminating process remains in the global concurrency owner set until cleanup settles. Both
Electron and browser-server shutdown close this admission seam, terminate and drain every owner,
and include any cleanup failure in their labeled runtime aggregate. Confirmed requested termination
is an expected cleanup result; exhausting the bounded close grace without confirming process-tree
release remains a lifecycle failure even though the UI request reports cancellation. Desktop
shutdown exits nonzero after an aggregate failure; it does not merely log the failure and report a
clean quit.

One cross-cutting backend owner is the prioritized work queue:

- `electron/ipc/backend-work-queue.ts`

All deferrable backend recomputation (git-status refresh chains and their convergence / review /
review-signals fan-out, plus background reconciliation) routes through `enqueueBackendWork` with a
global concurrency cap (default 3, `PARALLEL_CODE_BACKEND_WORK_CONCURRENCY`) and four priority
lanes: `interactive` (client-invoked mutation follow-ups) > `selected` > `visible` > `background`.
The queue dedupes pending jobs by key, reprioritizes focus-derived pending jobs when client focus
changes, and ages background jobs into the `visible` lane after 60s so they cannot starve forever.
Client focus arrives through the fire-and-forget `ReportClientTaskFocus` IPC channel
(`{ selectedTaskId, visibleTaskIds, focusedChannelIds? }`), owned on the renderer side by the
single reporter `src/app/backend-focus-reporter.ts` (leading-edge on selection change, debounced
for visibility churn, periodic keepalive against the 60s focus-registry TTL). Identity comes from
the authenticated browser client-id header (or the single Electron renderer), never request JSON,
and a client's focus contribution is cleared on disconnect. The `background` lane is gated until
`releaseBackendBackgroundWork()` runs after listen/window-load; it is the single post-listen
background scheduler, and the slow reconciliation sweep (~15s after release, one task at a time,
idle-lanes-only) repairs offline drift for never-focused tasks.

Derived backend snapshots are persisted by their backend owner:

- `electron/ipc/derived-state-persistence.ts` writes `<stateDir>/derived-state.json` (debounced
  ~2s, atomic) from the five snapshot sources: git status, task convergence, task review, task
  review signals, and task step summaries
- `electron/ipc/saved-state-restore.ts` is the shared shell-agnostic boot restore composed by both
  `server/browser-server.ts` and `electron/main.ts`: it syncs metadata registries from one parsed
  `SavedStateDocument`, starts watchers without scheduling blanket refreshes, hydrates the
  persisted derived snapshots behind exact identity filters (taskId + worktreePath + branchName +
  projectId; git-status entries must belong to a registered watcher worktree), and registers every
  restored task with the background reconciliation sweep
- hydrated snapshots may be stale until a demand refresh runs; the UI already presents
  `updatedAt`-relative recency, the selected task refreshes on first focus, and watchers cover live
  changes
- hydrated snapshots are emitted with fresh per-boot `stateVersion` counters, exactly like
  recomputed snapshots; all server-state category versions are per-boot, so the reconnect-version
  handshake carries the server instance identity (`getServerInstanceId()` in
  `electron/ipc/server-instance.ts`, a random UUID per server process) before it may skip
  bootstrap categories — presented versions are honored only when the presented instance id
  matches the current process, so a restarted server always serves the full bootstrap path
- the shared resync version vocabulary is `ResyncVersionMap` in
  `src/domain/server-state-bootstrap.ts`: per-category entries are the per-boot bootstrap
  versions (exposed by `getServerStateBootstrapVersions` in
  `electron/ipc/server-state-bootstrap.ts`), `'workspace'` IS the persisted `workspaceRevision`
  (the only restart-safe version, already consumed by the revision-keyed
  `GetBrowserReconnectSnapshot` skip), and `'agents'` is the transport agent-list counter
  carried on `agents` messages; no domain ever gets a second version space

Browser reconnect is version-gated end to end (delta resync):

- the renderer presents its `ResyncVersionMap` (collected by
  `collectServerStateCategoryVersions` in `src/app/server-state-bootstrap.ts`, injected into the
  control client through `setBrowserResyncStateProvider`), the last observed agents version, and
  the last observed `serverInstanceId` as reconnect socket query params
- `authenticateConnection` (`server/browser-control-plane.ts`) replays the missed window as one
  `control-replay-batch` frame, skips the agent list when the agents version is current, and
  sends a `state-bootstrap` containing only the stale categories (the connection-scoped
  `peer-presence`/`remote-status` categories are always resent); the bootstrap message doubles as
  the handshake-complete signal and always carries `serverInstanceId`. Legacy clients (no
  presented versions) keep the unconditional full bootstrap and per-event replay
- the control-event replay ring compacts by caller-supplied key
  (`getControlEventCompactionKey`): only full-replace-per-key message classes may compact
  (coordinator events by entityKey, git-status by worktree, task-ports by task, peer-presences,
  remote-status); tombstones share the entity's key so they supersede the earlier upsert.
  `run-meta-upserted` is the one partial-payload coordinator event (run scalars only), so it
  compacts on its own per-run slot instead of the run's entityKey — a blip-window meta mutation
  can never supersede the `run-upserted` creation snapshot in the ring. The client adopts the
  batch frame's `toSeq` wholesale because compaction makes inner seqs legitimately
  non-contiguous; mid-stream gap detection for live traffic is unchanged. Per-event (legacy)
  replay is reserved for gap-free windows: when compaction or eviction left holes in the missed
  window, the transport sends only the `replay-truncated` signal instead of a holey per-event
  replay — gap-detecting legacy consumers would otherwise misfire on the seq jump (the remote
  shell answers gaps with a hard reconnect whose own churn re-compacts the window, looping
  forever). Old clients answer `replay-truncated` with their full restore; the current client
  core adopts the signal's `latestSeq` wholesale so live traffic continues gap-free while the
  handshake bootstrap repairs state. On the client, the coordinator store applier adopts an
  event's `categorySeq` only when the event was fully applicable: orphan sub-entity deltas (and
  the meta-seeds-missing-run repair) leave the presented coordinator version stale so the next
  resync handshake resends the category
- batch-replay frames and conditional bootstraps ride the same strict-FIFO sequenced control send
  path (lane 0) as live broadcasts; nothing bypasses it
- the renderer no longer gates the reconnect-status skip on a 30s wall-clock window: whenever
  sequenced traffic confirmed the reconnect and no mid-stream sequence gap occurred, the cheap
  `GetBrowserReconnectStatus` content check (workspaceRevision / taskCommandControllerVersion /
  agentGenerations) decides; the status payload also carries `serverInstanceId`, but the skip
  comparison does not need it — taskCommandControllerVersion and agentGenerations are per-boot,
  so an instance change always fails the content check. `replay-truncated` no longer forces a
  full restore (stale categories arrive through the handshake), only a sequence gap or a status
  mismatch does
- per-boot category versions are only comparable within one server instance on the client too:
  the browser state-bootstrap applier (`src/app/server-state-bootstrap-registry.ts`) tracks the
  `serverInstanceId` carried on every state-bootstrap message and, when it changes (standalone
  server restarted under a surviving tab), resets every category's version tracking
  (`resetServerStateVersionTrackingForInstanceChange` in `src/app/server-state-bootstrap.ts`)
  before hydrating — otherwise the versioned replacement appliers would drop the restarted
  server's lower-versioned full bootstrap and wedge those categories until a page reload
- wake events (`online`/`pageshow`/visible after a >5s hidden gap) probe an OPEN socket with a 2s
  ping deadline (`probeLiveness` in `src/lib/websocket-client.ts`, policy in
  `WAKE_LIVENESS_PROBE`) instead of trusting it; a miss force-closes the zombie socket so the
  fast-reconnect table takes over
- one degraded-category contract covers bootstrap failures: a throwing category builder yields a
  `DegradedServerStateBootstrapSnapshot` marker instead of failing the whole bootstrap; the
  renderer records the degraded category, keeps prior state, and retries it targetedly (browser:
  the `request-state-bootstrap` control message; initial bootstrap: a single delayed refetch in
  `src/app/session-bootstrap-controller.ts`)

Task-command leases get a reconnect grace on both sides:

- the control plane defers the lease release for a disconnected clientId by
  `TASK_COMMAND_LEASE_RECONNECT_GRACE_MS` (30s); presence/takeover cleanup stays immediate,
  natural lease expiry (15s, non-renewing holder) still governs, and never-connected automation
  clientIds (`coordinator:` prefixes) keep immediate-prune semantics. Lease ownership itself is
  untouched: a peer takeover during the grace window wins and is never resurrected
- the renderer suspends (rather than invalidates) lease renewals on transport loss
  (`suspendAllTaskCommandLeaseRenewals`) and re-claims each suspended lease through the ordinary
  non-takeover acquire on reconnect, adopting the backend's NEW lease generation; denial
  invalidates that task's sessions, and a 30s client-side deadline falls back to the old full
  invalidation. Transport detects, the control plane defers release, and
  `electron/ipc/task-command-leases.ts` is unchanged

Agent availability is backend-owned sticky state:

- `electron/ipc/agent-availability-state.ts` owns per-agent availability snapshots, a monotonic
  per-boot state version, and background revalidation; probe results are sticky per process and
  there is no TTL re-probe on any user-facing request path
- probe rounds route exclusively through the backend work queue: the boot round is enqueued at
  `background` priority (so it stays gated behind `releaseBackendBackgroundWork()`), and
  dialog-open / settings-change revalidation runs at `interactive` priority, escalating a pending
  boot round through the queue's dedupe-by-key path instead of adding a second scheduler;
  repeat revalidation is throttled (~15s) except when the probe-target key changes
- `electron/ipc/agents.ts` is synchronous-from-state: `listAgents()` and
  `getAgentDefsWithLastKnownAvailability()` merge `DEFAULT_AGENTS` with last-known snapshots
  (`availabilityStatus: 'probing'` until the first probe lands) and never spawn a prober inline;
  the cold-bootstrap handler consumes the same sticky read, so it stays free of process spawns
- availability replays as the `agent-availability` server-state bootstrap category and pushes as
  `agent_availability_changed` through the generic `ipc-event` transport; live pushes are
  versioned envelopes (`AgentAvailabilityChangedEvent`, carrying the same backend state version
  as the bootstrap snapshot) so `src/app/agent-availability.ts` applies one stale-version guard
  to both paths — a pre-snapshot event replayed by startup buffering cannot overwrite newer
  snapshot truth — and the agent-catalog re-merge preserves applied availability so a stale
  catalog response cannot clobber newer truth
- the new-task dialog opens synchronously from the store catalog (probing agents stay
  launchable, with a probing badge in the agent picker) and fires a throttled
  `RefreshAgentAvailability` invoke in the background; spawn-time `validateCommand` remains the
  launch authority, so a stale badge can never block a launch

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

Prompt and question classification inside supervision must stay tail-local and canonical:

- a bare trailing prompt line by itself means `idle-at-prompt`, not `awaiting-input`
- prompt-adjacent interactive choice text such as Hydra selection prompts still counts as
  `awaiting-input` even if the operator prompt is already visible
- clearing an automatic pause such as `flow-control` or `restore` must reclassify from the saved
  tail instead of falling back to a generic `active` state
- shared renderer helpers that expose question/prompt state must reuse the same interpretation
  instead of inventing a separate prompt-cancels-question shortcut

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

The current architecture treats some state as backend-owned:

- git status
- remote access status
- agent supervision / attention
- agent availability (sticky per-process probe results)
- task step summaries derived from `.claude/steps.json`
- task port observation and exposure

The rule is:

1. backend detects or computes the state
2. backend pushes or replays it
3. clients project it into UI state
4. targeted refetch is a fallback, not the ownership model

This keeps reconnect semantics, multi-client behavior, and startup repair logic consistent across
Electron and browser mode.

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
- `src/domain/server-state.ts` owns the shared peer-presence snapshot validator used by both
  desktop/browser store projection and remote/mobile collaboration projection, so malformed replay
  entries cannot crash presence sorting or produce bogus owner cues
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
  - `src/remote/ws.ts` and `electron/remote/ws-server.ts` for sequenced controller, takeover,
    presence, and shared task-command lease result messages
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
- `src/app/terminal-dense-overload.ts`
- `src/app/terminal-frame-pressure.ts`
- `src/app/terminal-output-scheduler.ts`
- `src/app/terminal-surface-tiering.ts`
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

1. `TerminalView` registers with the attach scheduler instead of always attaching immediately;
   cold-hidden non-shell terminals defer their renderer attach entirely until visibility or
   prewarm intent, keeping the backend session (and supervision) live through
   `EnsureAgentSessionsBatch` (`src/app/agent-session-ensure.ts`)
2. the scheduler gives priority to the active task and focused terminal before background
   terminals; the drain skips ineligible candidates instead of breaking, so one pending foreground
   candidate cannot collapse background attach concurrency
3. attach scheduler slots are released as soon as the attach RPC is dispatched
   (`onAttachDispatched`), so slots only guard renderer CPU phases, never backend round trips
4. terminals show explicit `Connecting`, `Attaching`, and `Restoring` states while the attach path
   is still stabilizing
5. a terminal attach is one pipelined backend round trip: `AttachTerminalSession` binds the output
   channel for the requesting client, runs the spawn/attach workflow, and captures the initial
   recovery entry in the same backend tick, so no Data frame on the new channel can precede the
   recovery cursor; the spawn uses optimistic geometry (last-known or 80x24) and never resizes an
   existing session, and fit gates paint, never spawn. Reconnect and non-startup recovery still go
   through the shared `GetTerminalRecoveryBatch` coalescing path, while visible non-shell startup
   attach uses the backend-owned `GetTerminalStartupRecoveryBatch` path; non-attach recoveries are
   cursor-first (no rendered-tail upload) with capped snapshots, and a `tail-needed` response asks
   the client for one bounded 64KB tail before any destructive truncated snapshot. The backend owns
   the restore pause lifetime for batched recoveries: every recovery request (and the attach RPC)
   holds its own request-scoped pause under a unique `batchPauseId` even when the agent is already
   paused (restore pause leases stack), the client releases every pause id it observed after apply,
   and a 5s server auto-resume timer covers a lost release; this replaces the per-terminal
   `PauseAgent`/`ResumeAgent` round trips
6. visible startup recovery is split by terminal type:
   - visible non-shell startup attach uses `GetTerminalStartupRecoveryBatch`, and the backend
     prefers serialized `terminal-state` payloads from its headless xterm mirror for `selected` and
     `visible-sibling` terminals
   - visible shell attach stays on the ordinary attach/recovery path, but local rendered-tail
     replay is suppressed so reload/background-switch shell continuity does not fall back to
     renderer-side request-state overlap
   - hidden attach and non-startup restore paths still use the ordinary recovery contract
7. replay/apply throughput is still paced in the renderer, but visible-startup state reconstruction
   now lives on the backend so startup no longer depends on renderer-side "smaller replay" heuristics
8. fit/restore readiness is explicit before queued output is flushed into xterm
9. the loading surface masks the live xterm container until live render is ready, so users do not
   watch blocking startup snapshot application scroll underneath the startup UI
10. terminal presentation truth is explicit at the surface level: a terminal may be `live`,
    `loading`, or `error`; only `loading` masks the live xterm container, while visible unfocused
    terminals stay on the real terminal surface even if their scheduler tier is deprioritized
11. once attached, terminal output is drained through a shared runtime scheduler instead of each
    terminal independently racing its own frame/timer path
12. WebGL acceleration is a steady-state focused-surface optimization, not a startup/restore
    renderer: only a focused terminal in ready, non-restore-blocked state may claim WebGL. Once a
    visible terminal has already claimed WebGL, it retains that renderer while it remains visible
    so ordinary focus handoffs or sibling-pane changes do not flip it back to the DOM renderer.
    If all WebGL slots are already held by still-visible terminals, additional visible terminals
    stay on the DOM renderer instead of evicting a visible WebGL owner and causing renderer churn.
    Hidden, startup, and restore-blocked paths stay on the real DOM xterm surface unless they are
    explicitly promoted later. Focused terminals that already own WebGL keep it through committed
    resize churn so large-buffer resize replay does not fall back to the slow DOM repaint path.
13. queued/background terminal startup now has a shared renderer-side activity owner in
    `src/store/terminal-startup.ts`, so the app can show one subtle aggregate startup indicator and
    compact per-task sidebar hints without each `TerminalView` inventing its own global status view
14. the public terminal lifecycle now stays visible in `terminal-session.ts`, while input dispatch,
    output/write flow control, and recovery/rebind behavior live behind the named terminal-view
    owners instead of re-accumulating in one file
15. experimental many-terminal heavy-load policy is split cleanly:
    - `src/app/terminal-high-load-mode.ts` owns the runtime-facing mirror for the product setting
    - `src/app/terminal-frame-pressure.ts` and `src/app/terminal-dense-overload.ts` own measured
      pressure and guarded overload detection
    - scheduler/output owners consume that state as pacing and write-shaping policy only
    - `src/app/terminal-surface-tiering.ts` plus `src/components/TerminalView.tsx` own
      presentation/runtime surface policy such as visible-surface truth, render hibernation,
      selected handoff, and prewarm interpretation
    - backend recovery truth, task attention, and PTY flow-control ownership stay outside those
      presentation/runtime seams

Important property:

- visible-startup recovery is now server-owned terminal-state recovery instead of renderer-serialized
  historical output; if the headless mirror is unavailable, diagnostics count the fallback and the
  backend returns the ordinary compact snapshot path
- the backend PTY hot loop only records bytes; utf8 decoding plus supervision, port-scan,
  input-trace, and terminal-state-mirror writes run once per batch flush (and run before the
  no-subscriber early return so unattached coordinator agents keep supervision live).
  `TerminalStateMirror.serializeLatest()` answers against the last applied mirror write with an
  `appliedCursor`, and startup recovery composes the remaining ring-buffer delta on top, so a noisy
  terminal's mirror backlog cannot stall the selected terminal's recovery
- the browser channel plane drains through outbound lanes (`server/browser-outbound-lanes.ts`).
  Lane invariant: ALL sequenced control-plane messages — live broadcasts, per-event replay,
  batch-replay frames, and bootstrap messages — ride lane 0 on the existing strict-FIFO control
  send path and are never reordered; only bulk channel data frames ride the lower lanes
  (focused-channel frames first, then background channels round-robin under a per-pass byte budget
  with a bufferedAmount soft cap). Focused-channel priority derives from the single focus signal
  (`ReportClientTaskFocus.focusedChannelIds`, published only by `src/app/backend-focus-reporter.ts`
  from the renderer registry in `src/app/terminal-focused-channels.ts`). The lane scheduler is
  per channel manager, not per client: it consumes the merged union of every connected client's
  focused channel ids, so a channel focused by one client also drains with focused priority (and
  focused byte budget) toward other clients. That is a deliberate fairness tradeoff, not an
  ownership change — single-focus authority stays with each renderer — and any move to per-client
  lanes must keep lane 0 strict-FIFO per client
- steady-state continuity still stays delta-first: attach / backpressure / hibernate recovery now
  drains queued local output before asking the backend for recovery state so the renderer and
  backend agree on the current tail, while reconnect replacement restores deliberately preserve the
  queued tail until the replacement restore wins so reconnect churn cannot reorder or duplicate live
  output
- global startup visibility stays separate from backend-owned task attention; local
  attach/restore progress belongs to the renderer-side startup owner, not to
  `src/app/task-presentation-status.ts`
- local terminal fit stays local, but committed PTY resize authority follows backend task-command
  control; peer-controlled geometry is deferred locally and server-side resize requests are accepted
  or rejected by the current task owner. Reattaching an existing session must not implicitly resize
  the shared PTY; explicit resize commands own that mutation, and recovery responses carry both
  backend rows and columns so the renderer aligns to backend PTY geometry before replay
- dense-overload and surface-role reductions remain explicitly experimental and
  presentation/runtime-only; they may reduce browser work under load, but backend recovery truth and
  switch ownership stay unchanged

## Task Ports And Preview

Parallel Code now has a task-scoped preview model, not a generic "proxy any localhost port" model.

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

Parallel Code runs tasks on the host, not in a strict sandbox. Detection is advisory, while
exposure is explicit and task-scoped.
Preview target revalidation also reports backend runtime diagnostics for cache reuse, probe
success, connection failure, timeout failure, target, and duration. Those diagnostics are
generation-guarded so cache entries and probes that began before
`reset_backend_runtime_diagnostics` cannot pollute the next measured scenario.

## Supervision And Attention Flow

The task attention path is a product-facing reliability path.

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
- coordinator-run operator states (`stale-after-restore`, pending workflow approvals,
  budget-exhausted workflows) join the same pipeline as renderer-side
  `coordinator-stale`/`coordinator-approval`/`coordinator-budget` attention reasons; they are pure
  renderer projections of backend run snapshots (`getCoordinatorTaskAttentionSummary` in
  `src/app/coordinator-attention.ts`), never new wire state, and the domain
  `TaskAttentionReason` validator is untouched
- `src/components/SidebarTaskRow.tsx` renders the compact sidebar attention and review signals inline with each task row

This stays separate from raw task/agent dot status derivation. Attention and review are richer task
supervision concepts, but they now surface through the same compact task-list UI instead of
separate top-level queue panels.

All renderer-initiated coordinator operator actions (`resume_run`, `pause_run`, `unpause_run`,
approvals, lane retries) route through one app-layer workflow,
`src/app/coordinator-operator-actions.ts`, so the coordinator rail, the task title bar Resume
affordance, and any future surface share one request shape, run lookup, and rejection mapping.

`src/components/task-panel/TaskCoordinatorSectionEntry.tsx` is the stable task-panel boundary for
the coordinator rail. It preserves the fixed `PanelChild` contract while lazy-loading the full
`TaskCoordinatorSection.tsx` inspector only when a coordinator task is rendered. Compact
coordinator attention remains eager through `src/app/coordinator-attention.ts`; inspector-specific
workflow projection and controls stay out of the default task-panel startup bundle. The inspector
owns one request generation keyed by task, run, popover kind, and target across tool, operator,
spawn, and clipboard actions; switching target/run, starting a newer action, or unmounting
invalidates the older completion so it cannot overwrite the current popover or clear newer busy
state.

## Perceived-Latency Presentation Owners

The startup and action-feedback layer keeps real latency windows truthful with renderer-local
presentation state. These owners are presentation-only by design and must never become restore or
canonical-state truth:

- `src/app/app-startup-status.ts` owns the coarse `isAppStartupPresentationPending()` window:
  begun at desktop session startup entry, completed at startup completion, failure, and dispose.
  `TilingLayout`, `Sidebar`, and `SidebarProjectsSection` suppress first-run onboarding while it
  is pending.
- `src/app/workspace-shape-cache.ts` caches the last-known workspace shape (task names, project
  count) in localStorage, keyed by the serving origin so one browser profile pointing at two
  servers cannot render the wrong ghost shape. It is a presentation cache only: nothing may
  hydrate canonical state from it. Returning users get correctly-shaped ghost columns
  (`src/components/WorkspaceStartupSkeleton.tsx`) while bootstrap is pending; users with no cached
  shape still get first-run onboarding. Two write guardrails keep the cache a truthful
  returning-user signal: the persistence subscription never schedules a write while
  `isAppStartupPresentationPending()` (the subscription registers before the awaited cold
  bootstrap, so an unguarded debounce would clobber the cache with the still-empty store), and an
  empty shape (no projects, no tasks) is never cached — persisting an emptied workspace removes
  the entry and a previously cached empty shape reads as no cache.
- a failed startup must degrade honestly: when bootstrap or the desktop session startup fails
  over a live connection, clearing the startup status drops the skeleton, so the failure also
  routes through the persistent error-class notification. A returning user never gets a silent
  false first-run empty state.
- `src/app/task-creation-optimism.ts` owns provisional `PendingTaskCreation` records rendered as
  `src/components/PendingTaskColumn.tsx`. Pending ids never enter `store.tasks`/`taskOrder`, are
  never persisted or synced, and there is deliberately no provisional-id to real-id swap: the real
  task lands through the unchanged `createTask` store insert and the ghost is removed in the same
  resolve continuation. Pending panels mount as `transient` `ResizablePanel` children, which are
  excluded from panel-size persistence so provisional ids can never leak into `store.panelSizes`.
- optimistic coordinator action state must drive the click intent it renders: while the
  pause/unpause flip is active, the rail derives the label, busy id, and dispatched tool from the
  flip target (never from the stale run view), and an accepted resume keeps the rail/title-bar
  Resume controls disabled until a newer run snapshot lands so duplicate requests cannot surface
  spurious rejection alerts.
- `src/components/terminal-view/terminal-pending-session-input.ts` buffers keystrokes typed
  between focusing a terminal and the session object existing, keyed by `terminalStartupKey` with
  a byte cap and a drain TTL. `acceptStartedTerminalSession` drains it into
  `session.handleTerminalData` before any later input; the task-state cleanup authority clears it
  on task removal.
- the terminal loading overlay renders a dimmed static last-known screen
  (`getTaskTerminalPlaceholderTail` in `src/store/task-terminal-slate.ts`, falling back to the
  supervision preview on cold start) under the masked surface. Placeholder removal and the
  queued-input indicator key off the `data-terminal-live-render-ready` transition per
  TERMINAL-CONTRACT, never off loading copy.
- error-class notifications (`src/store/notification.ts`) persist until dismissed and carry the
  failed action name; info notifications keep the auto-dismiss window.

## Bundled Runtime Assets

Agent runtimes that the product claims to bundle need a runtime-asset resolution path that works across:

- local development
- Electron packaged layout
- standalone browser/server builds

Hydra now resolves through `electron/ipc/runtime-assets.ts` instead of assuming one compiled
directory layout. The rule is:

- bundled tools should either work everywhere the product claims they work
- or fail with a concrete reason that the UI can surface
- `electron/ipc/hydra-adapter.ts` remains the protocol owner for its intentionally long-lived
  daemon and operator children: bounded health and HTTP shutdown requests drive the normal
  lifecycle, while the shared bounded subprocess owner runs with no automatic child deadline and
  owns process-group/tree termination, escalation, exit waiting, and stream cleanup when shutdown
  or adapter signals fail. Adapter failure and signal paths settle daemon and operator cleanup
  together; a requested termination is successful only after tree release is confirmed, and any
  independent operation/cleanup failures remain composed for the nonzero adapter exit.

Electron package dependencies follow the same ownership boundary. Packages imported only by
`src/**` are Vite build inputs and belong in `devDependencies`; their code is already emitted into
`dist` and `dist-remote`, so copying their source trees into the Electron Node runtime only adds
size and duplicate authority. `dependencies` is reserved for Electron/backend runtime imports and
the vendored Hydra runtime. `scripts/verify-electron-package.mjs` rejects renderer-bundled package
trees, requires the unique locked name/version identities represented by all non-development,
non-optional package-lock entries plus every declared direct runtime dependency in each produced
archive (so legitimate package-manager hoisting is layout-independent), recursively checks every
packaged build/runtime input for freshness, verifies every archive from multi-target release
builds, and rejects known test, benchmark, demo, coverage, snapshot, and runner-config artifacts
from dependencies. The standalone server uses `server/tsconfig.build.json` as its production-only
emit boundary;
`server/build-server.mjs` removes the previous output before compilation, scans successful output
for development artifacts and Vitest imports, and removes failed partial emits, while
`server/tsconfig.json` remains the broader typecheck boundary that includes tests. Session-stress
and server integration harnesses invoke this production build owner too; raw non-watch TypeScript
emits must not repopulate the shared `dist-server` tree with test modules after it was validated.

Browser static delivery is precompressed and cache-aware:

- `scripts/compress-dist-assets.mjs` (wired into `prepare:browser-artifacts`) writes `.gz` and
  `.br` siblings for compressible `dist`/`dist-remote` assets; `--check` is the CI byte-budget gate
  (gzipped main bundle < 250KB plus the terminal-session modulepreload link), enforced because
  `prepare:browser-artifacts` runs it after the compress step and CI's `npm test` prepares browser
  artifacts
- `server/browser-static.ts` serves the precompressed sibling with `Content-Encoding` and
  `Vary: Accept-Encoding` when the client accepts it (identity fallback for dev watch dirs), adds
  `Cache-Control: public, max-age=31536000, immutable` for hashed `/assets/` files, and keeps HTML
  `no-store`
- the Vite build injects modulepreload links for the lazily imported terminal-session chunk and its
  static import closure (plus prefetch hints for its dynamic xterm addon chunks), computed from the
  bundle graph in `electron/vite.config.electron.ts`; the remote bundle is a single chunk and needs
  no equivalent injection

## Core Concepts

### Projects

Defined in `src/store/types.ts` and managed mainly in `src/store/projects.ts`.

A project is the persistent repo-level configuration:

- path
- display name
- project mode, defaulting to git when omitted
- branch prefix
- default task Git isolation (`worktree` or project root)
- delete-branch defaults for managed worktrees
- bookmarks

Projects matter to both task creation and git status lookup.

### Tasks

Defined in `src/store/types.ts` and managed mainly in `src/store/tasks.ts`.

A task is the main desktop-level unit. It carries:

- explicit execution mode (`agent` or `terminal`)
- human name
- project association
- branch name
- worktree path
- Git isolation, base branch, and worktree ownership
- agent IDs for agent-mode tasks
- selected agent ID, which is a projection hint for prompt and terminal targeting
- task-scoped shell IDs
- notes
- prompt state
- plan content
- optional `stepsTracking` config for backend-owned `.claude/steps.json` tracking
- agent-mode runtime and permissions config

The UI is task-centric. Agents are mostly viewed through the task that owns them.

One ownership split matters here:

- `Task.stepsTracking` is durable task config
- task step history and next-action summary are not persisted inside `Task`
- the backend owns `.claude/steps.json`, projects replayable snapshots, and repairs malformed or
  unstamped entries before renderer code sees them

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
- optional backend runner identity for non-host execution

Status is partly authoritative from the backend and partly interpreted on the frontend.

One ownership rule matters here now:

- agent definitions declare `resume_strategy`
- CLI-style agents resume through launch arguments
- Hydra resumes through backend-owned startup recovery in the vendored operator runtime
- renderer code may request a resumed spawn, but it must not recreate Hydra's `:resume` workflow or
  special-case Hydra boot timing locally

That split exists because persisted workspace state can outlive backend PTY sessions. After a server
restart, the first attach still owns the real recovery decision. For Hydra, that recovery is now
worktree-scoped and serialized in the backend/vendored runtime instead of being approximated in the
renderer.

Runner identity follows the same ownership rule: a project may configure the preferred runner, but
the active runner instance is backend PTY/supervision metadata. Browser and mobile clients consume
that projection; they do not decide whether a Docker container is live by reading project settings.

### Terminals

Extra standalone terminal panels stored in `src/store/types.ts` and `src/store/terminals.ts`.

These are not task agents. They are UI panels backed by shell agents, but conceptually they are
side terminals rather than the primary task execution lane.

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

Preview is not part of the websocket transport. It is an authenticated HTTP/WebSocket
reverse-proxy concern layered on top of task-scoped exposure state.

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
- the remote/mobile agent list deliberately filters shell PTYs; terminal-only task sessions are not
  represented there because that surface does not yet have a task/session projection
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
  - remote/mobile triage surfaces now project actionable row state from the pushed backend control
    streams instead of recency-only renderer heuristics:
    - `agent-supervision` owns waiting / ready / busy / protected / failed state
    - `task-review` owns changed-file and conflict summary
    - `task-ports` owns preview-port availability
    - task-command controller snapshots own blocked-owner / read-only truth
    - peer presence remains a softer activity cue until controller snapshots confirm ownership
  - replayed peer-presence entries are validated before sorting or projection so malformed
    transport data cannot crash the remote shell or become a false ownership cue
  - remote task-state projections use the shared server-state version tracker for supervision,
    review, and task-port replay so stale live snapshots or removals cannot erase newer bootstrap
    truth

This runtime is still simpler than browser desktop, but it is no longer just a read-mostly shell.
It shares session naming, presence, ownership, and takeover behavior with desktop while keeping its
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

1. `server/main.ts` bootstraps `server/browser-server.ts`; boot is snapshot-first and
   demand-driven:
   - persisted state is parsed once into a `SavedStateDocument`
     (`electron/ipc/saved-state-document.ts`) shared by the registry sync, restore, and
     save/load/reconnect consumers instead of re-parsing the JSON per consumer
   - `electron/ipc/saved-state-restore.ts` restores watchers and hydrates persisted derived
     snapshots from `derived-state.json`; no per-task git refresh is scheduled at boot
   - the coordinator runtime is not imported before listen; `server/coordinator-runtime-loader.ts`
     dynamic-imports and initializes it on the server `listening` event, and every coordinator
     entry point (the `/api/coordinator/tool-call` route and the lazy coordinator IPC group bound
     through `electron/ipc/lazy-handler-group.ts`) awaits the single load promise, so an early
     coordinator request is answered after init completes instead of being rejected. Owner
     acquisition is transactional: if a later initialization step fails, every earlier persistence,
     mutation-producer, and event-consumer owner is asked to release in shutdown order before
     readiness rejects. A successful rollback releases the serialized ownership turn so a later
     loader may retry; a failed rollback preserves both errors, leaves the turn unreleased, and
     rejects replacement admission
   - clients whose WS auth or cold bootstrap landed inside the load window received an empty
     coordinator category; the loader repairs them after hydration by re-emitting the restored
     runs as ordinary `run-upserted` events (`emitCoordinatorRunRepairEvents`), and shutdown
     awaits the loader's async `cleanup()` before the exit-on-close path. Cleanup first closes and
     drains coordinator mutation producers (active prompt chains, the workflow scheduler execution,
     admitted tool/renderer calls including their persisted result-ledger writes, and nested spawn
     rollbacks), then unsubscribes outbound event consumers, and flushes persistence last; every
     owner is attempted and failures are aggregated, so one rejection cannot
     skip a later cleanup or make a rollback mutation non-durable. Loader instances serialize owner
     acquisition behind the prior loader's full teardown, so synchronous browser-server cleanup can
     be followed immediately by an in-process replacement without overlapping persistence owners.
     Failed owner cleanup retains the failed admission barrier and rejects both public cleanup and
     any replacement loader, which makes signal-driven browser shutdown exit nonzero rather than
     acquiring owners over an uncertain predecessor; cleanup before the `listening` callback settles
     the never-started loader explicitly
   - the Electron shell does not use the loader: `electron/ipc/register.ts` hydrates persisted
     coordinator state eagerly (`ensureCoordinatorServiceLoaded`) before binding IPC handlers so
     the renderer's first `GetServerStateBootstrap` already carries restored runs
   - `releaseBackendBackgroundWork()` runs inside the listen callback as the single post-listen
     background scheduler
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

- browser mode is shaped to feel like Electron mode to the UI, but the actual transport is
  explicitly split under the surface.

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
   - websocket control messages for takeover request / response and shared lease result parsing
9. the remote UI receives both terminal data and collaboration state, then projects them into:
   - agent cards and previews
   - ownership chips and read-only states
   - takeover dialogs and result notices

Important property:

- remote/mobile is not "the desktop UI in a smaller layout"
- it is a separate agent-view application that shares backend services, transport rules, and
  task-command control semantics

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

- there is now a workflow layer on both the frontend and backend
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
   - it also renders backend-owned task container inspect state, actions, logs, and declared app
     previews through `TaskContainersPanel`, while the preview controller owns inspect/log/action
     sequencing, stale-request suppression, and explicit error-state management
7. browser mode opens exposed ports through `/_preview/:taskId/:port/*`

Important properties:

- detection is advisory
- exposure is explicit
- preview proxy responses rewrite target cookies onto the preview path and strip upstream cookie
  domains so app sessions stay scoped to the Parallel Code preview origin
- task container previews are distinct from observed/exposed task ports:
  - container previews come from backend-owned inspect truth
  - task-port previews come from port detection, explicit exposure, and authenticated preview routes
- task-container preview workflow is distinct from presentation:
  - `src/components/task-panel/task-panel-preview-controller.ts` owns request ordering, stale-result
    suppression, and error state
  - `src/components/TaskContainersPanel.tsx` renders that workflow-owned state
- preview state is replayable after reconnect
- task deletion clears task-scoped port, review, permission, takeover, focus, and layout state
- opening preview is snapshot-first; the controller renders current task-port truth immediately and
  expensive candidate scans stay behind explicit rescan policy

### 4c. Task Steps / Progress Tracking Flow

Flow:

1. task creation stores `stepsTracking` on the durable task config
2. backend task workflows register tracked tasks with `electron/ipc/task-steps.ts`
3. `electron/ipc/task-steps.ts` watches `.claude/steps.json`, normalizes rows, preserves explicit
   tracking-disabled tasks, repairs or stamps timestamps with the host clock, and emits replayable
   summary snapshots
4. renderer clients receive `task-steps` updates through:
   - Electron IPC in desktop mode
   - browser control-plane replay/push in browser mode
5. `src/app/server-state-bootstrap.ts` applies compact summary snapshots during browser cold
   bootstrap and reconnect replay without shipping full history by default
6. `src/store/task-steps.ts` stores:
   - compact per-task summaries for sidebar/attention/task-panel projections
   - lazily fetched full snapshots when the steps surface is active
7. `src/app/task-presentation-status.ts` maps ready step summaries into existing
   `ready-for-next-step` attention semantics instead of inventing a second readiness channel
8. `src/components/task-panel/task-panel-steps-controller.tsx` lazy-loads the full snapshot only
   when the task is active or the steps panel is focused, then `TaskStepsSection.tsx` renders the
   history, next action, and jump affordances
9. `src/app/task-steps.ts` keeps prompt seeding, next-action prefill, and jump routing aligned with
   current task focus owners

Important properties:

- `.claude/steps.json` is the durable shared artifact; renderer code must not poll or parse it
  directly
- browser cold bootstrap carries only compact summary snapshots by default
- full step history is fetched lazily per task
- backend timestamps are authoritative; model-provided timestamps are normalized, repaired, or
  overwritten before projection
- local UI state such as expanded cards or per-tab prefill remains local and is not shared

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
- this area still resists aggressive abstraction
- noisy background terminals should not be able to keep themselves hot purely by repaint volume
- focused user-driven terminal transitions may use short app-owned preemption so task switches and
  typing stay ahead of background drain pressure
- focused terminals may still fast-path small plain output, but redraw-heavy control bursts should
  be paced so the UI does not expose every intermediate repaint frame
- that pacing works on raw bytes and must not invent terminal semantics: transport chunks are not
  ANSI boundaries, and the renderer still writes the original bytes to xterm unchanged
- queued browser control/channel diagnostics are generation-guarded so delayed channel sends and
  micro-batched control broadcasts from before a diagnostics reset cannot contaminate the next
  measured scenario
- more aggressive hidden-terminal suspension remains experimental until wake and restore costs are
  proven at the same browser-validation bar

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

Visible non-shell startup attach uses `get_terminal_startup_recovery_batch` instead. That path can
return `terminal-state`, a backend-owned serialized xterm state produced from the PTY mirror, with
compact `snapshot` as the fallback if the mirror is unavailable.

Important property:

- browser recovery is now explicit catch-up, not implicit live replay of historical output
- `delta` and `noop` recovery should stay non-blocking in the renderer; only full-state recovery
  (`terminal-state` or snapshot fallback) should surface a blocking restore state
- selected handoff protection may temporarily prioritize restore and replay for the selected
  terminal, but that ordering aid remains presentation/runtime policy rather than backend truth
- experimental live-surface caps remain presentation/runtime policy only and do not change backend
  recovery truth
- destructive reset is reserved for full-state recovery, not ordinary delta/noop continuity
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

- `electron/ipc/bounded-process.ts`
- `electron/ipc/git-exec.ts`
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
- asynchronous Git commands enter through `git-exec.ts`, while `bounded-process.ts` owns their one
  buffered-or-streamed process lifecycle, deadline, process-group/tree termination, and cleanup
- the batched `git cat-file` reader may fall back to individual safe reads after an ordinary Git
  failure, but not after bounded cleanup exhausts its deadline without confirming process-tree
  release
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

The backend additionally persists its own derived external-state snapshots:

- `electron/ipc/derived-state-persistence.ts` owns `<stateDir>/derived-state.json`
  (`formatVersion` gated, debounced atomic writes, tolerant per-entry load)
- on boot, both shells hydrate those snapshots through
  `electron/ipc/saved-state-restore.ts` behind exact identity filters against the registered task
  metadata; a missing or corrupt file simply boots with empty snapshot maps
- hydrated snapshots are demand-repaired (selected-task refresh on focus, watcher-driven refresh on
  real changes, background reconciliation sweep for never-focused tasks) instead of being eagerly
  recomputed for every task at startup

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
- start, stop, and refresh share one frontend generation guard so stale async completions cannot
  re-enable or disable remote access after a newer user action
- peer-count-only updates do not mutate disabled remote-access status, so stale browser-side count
  messages cannot violate the disabled-state invariant
- remote-access connected-client counts stay separate from collaboration peer presence; browser and
  remote/mobile presence now share one payload/runtime contract, while each shell keeps its own UI
  projection

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

That model is correct, but it is still the most complex runtime.

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

The backend now has a workflow layer. The remaining problem is not the lack of workflows; it is
that the low-level service and handler surface is still large and uneven.

Hotspots:

- `electron/ipc/handlers.ts`
- `electron/ipc/git.ts`
- `electron/ipc/tasks.ts`

Why this matters:

- large capability modules still make it easy to smuggle use-case behavior back into services
- the next quality gains are likely to come from shrinking and clarifying these modules, not from inventing more new layers

### 5. The Protocol Is Shared, But The Projections Are Still Different By Design

The desktop UI is task-centric. The remote/mobile UI is agent-centric. Browser mode adds channel framing for terminal output.

That is not a bug. It reflects the product surfaces. The remaining challenge is keeping the shared
concepts consistent across those projections.

Why this matters:

- new features must decide whether they belong to the shared concept, the desktop projection, the remote projection, or only one transport plane

### 6. Canonical Derivation Is Better, But Not Fully Closed

Recent work improved several concepts:

- backend canonical agent status now exists
- browser git state now prefers server-owned push/replay
- review and convergence state are now backend-owned, pushed, and replayed
- task-dot, attention, and focus semantics now come from one canonical presentation mapper
- remote-access status now uses a clearer enabled/disabled contract
- remote presence now has one shared payload/runtime contract across browser desktop and
  remote/mobile, with runtime-specific projections kept at the UI edge
- browser replay and Electron startup hydration now register bootstrap-owned state categories through
  the shared bootstrap registry and session bootstrap gate

Still mixed:

- Electron git delivery still includes some targeted on-demand refresh in advanced UI surfaces
- remote presence projections are still runtime-specific because desktop and mobile show different
  shells, but they consume the same backend peer-presence truth
- browser viewport/focus geometry still needs targeted browser proof when it changes, even though
  committed PTY resize authority is tied to backend task ownership
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
- peer presence payload and runtime publication
- task presentation mapping
- bootstrap-owned state-category replay through the shared session bootstrap registry

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
- reconnect restore now stays in `reconnecting` until authenticated control traffic confirms the
  restore can actually begin
- reconnect restore cancellation is explicit when transport churn, auth expiry, cleanup, or restore
  failure invalidates an in-flight restore

Why this matters:

- recovery is one of the hardest places for quality to drift silently

### 8. The terminal path is special and should stay explicit

The terminal/output path crosses PTY services, transport, browser channel fanout, and UI rendering.
The goal is clear contracts, explicit backpressure rules, and explicit recovery semantics, not fake
uniformity.

That now includes an explicit latency policy for browser typing:

- control keys such as Enter and Ctrl+C flush immediately
- isolated single-key interactive input prefers an idle fast path instead of sitting behind the
  old 4-8ms browser batch delay
- short interactive bursts still use a tiny batch window instead of sending every key blindly
- large paste or bulk input stays on the bounded batching path
- the renderer does not own lease truth; it only asks the task-command lease session whether a
  retained lease is still hot
- browser task-command lease acquire / renew / release requests use authenticated transport identity
  instead of trusting JSON `clientId`, and pagehide release uses keepalive HTTP with the browser
  client-id header
- the PTY service mirrors the same split:
  - interactive input drains on `setImmediate`
  - bulk input keeps the short timed batch
- browser restore pauses are keyed by a renderer-generated restore lease id and renewed while a slow
  restore is active; stale resume ids cannot clear a newer scoped restore pause
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

## Relationship To Testing

Testing matters here only where seam choice follows architecture.

- backend and transport contracts should be proven below the browser first
- churn-heavy UI behavior should be proven at the renderer seam that owns it
- startup, persistence, replay, and reconciliation need explicit coverage because ownership crosses
  backend, workflow, and projection boundaries

Validation policy, quality gates, and command guidance live in
[TESTING.md](./TESTING.md). Terminal/browser-lab workflows live in
[TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md).

## Practical Delta Summary

The current system does not need a new architecture.

The delta is narrower:

1. keep product-behavior coverage expanding with the highest-churn UI surfaces
2. keep startup, persistence, and reconciliation coverage strong as those flows evolve
3. keep tightening canonical derivation and shared type contracts where new features touch them
4. keep server-owned state push/replay semantics boring and consistent across runtimes

The next useful architectural work is targeted cleanup around ownership, derivation, and type
boundaries, not another transport rewrite.

## Current Direction

The current architectural approach is:

1. keep the shared transport core stable
2. make browser mode explicit instead of pretending it is a single transport
3. prefer workflow modules for multi-step behavior
4. prefer server-pushed state for server-owned concepts
5. keep composition roots thin and keep business logic out of runtime adapters
6. use stronger typing to catch lifecycle drift before runtime

Recent phases have already been moving in this direction.

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

Architecture tests back these rules so future feature work fails early when it starts to drift.

One current example is review UI: `ReviewPanel.tsx`, `DiffViewerDialog.tsx`, and
`PlanViewerDialog.tsx` now share `src/components/review-surface-session.ts` for review-session,
copy/export, and sidebar bootstrap instead of each rebuilding that wiring locally. The review
panel's remaining loading and selection state belongs in
`src/components/review-panel/review-panel-controller.ts`.

## Current Gaps

The architecture is in better shape than the earlier refactor phases assumed. The remaining gaps
are narrower and more product-facing.

### 1. Reliability Proof Is Now The Main Gap

Recent hardening work made bootstrap/replay state ownership, review freshness, supervision
presentation, and preview trust more explicit.

What still matters:

- proving reconnect churn, restore overlap, and multi-client browser behavior through scenario tests
- stress-testing long-lived browser sessions and the heavy terminal/replay paths with repeatable diagnostics
- keeping deploy-readiness smoke tests and canary checks as a first-class part of the release bar

### 2. Product-Behavior Coverage Should Keep Growing With The Product

Recent work added direct screen coverage for the highest-churn UI surfaces.

What still matters:

- keep adding screen tests when task creation, focus management, terminal UX, or review flows evolve
- add app-level scenario coverage when reconnect, restore, and pushed state behavior become more sophisticated

### 3. Startup And Reconciliation Remain High-Risk Areas

`desktop-session.ts` and persistence now have direct integration tests, but startup remains one of the easiest places for subtle regressions.

Why this matters:

- startup order bugs often look nondeterministic
- stale persisted state can silently corrupt UI assumptions if the tests drift

### 4. A Few Shared Concepts Still Have More Than One Projection

This is better than before, but still worth watching when future features land:

- remote presence projections across desktop and mobile shells
- git refresh behavior in advanced or future UI surfaces

### 5. The Terminal Path Is Still Intentionally Complex

That is acceptable, but it means terminal-related feature work should continue to treat:

- PTY behavior
- websocket/channel behavior
- UI recovery behavior

as one reliability-sensitive path, not as isolated modules.

## Next Phases

The next quality phases should build on the current direction.

For deeper follow-up design ideas around terminal transport, multi-client control lifecycle,
restore strategy, and invariant testing, see
[TERMINAL-INFRA-FOLLOW-UPS.md](./TERMINAL-INFRA-FOLLOW-UPS.md).

### Phase 8: Production Confidence And Scenario Coverage

Goal:

- prove the existing design under real browser, reconnect, preview, review, and multi-client conditions

Targets:

- add browser-mode scenario coverage for auth/bootstrap, reconnect, restore overlap, and preview replay
- keep the task-deletion browser canary covering review/preview-open cleanup current as those surfaces change
- add standalone deploy smoke tests
- keep flake-management and diagnostics around the heavy latency/replay suites explicit instead of ad hoc

### Phase 9: Performance Confidence And Observability

Goal:

- make the system measurable under load as well as architecturally sound

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
- after that, the product can grow on the current foundation without another broad refactor campaign

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
