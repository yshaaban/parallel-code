# Architectural Principles

This document is the normative architecture guide for Parallel Code.

Use it to evaluate:

1. new features
2. refactors
3. bug fixes
4. test strategy
5. whether a change is aligned with the direction of the repo

If `docs/ARCHITECTURE.md` explains how the system currently works, this document explains how changes are expected to fit together.

## Purpose

Parallel Code has a lot of moving parts:

- Electron desktop
- standalone browser/server mode
- remote/mobile mode
- PTY-backed agents
- git/worktree orchestration
- replayable server-owned state
- task-centric UI with multiple dialogs and panels

The system stays maintainable only if ownership is explicit.

The core rule is simple:

**Every important domain should have one clear owner, one clear transport boundary, and one clear presentation layer.**

## Core Principles

### 1. Backend owns real external state

If state depends on the filesystem, git, PTYs, process execution, preview reachability, or server-side observation, the backend is the authority.

Examples:

- git status
- diffs and binary detection
- task port observation and exposure
- supervision snapshots
- plan file discovery and reads
- long-running git push progress

The renderer may project this state, but it must not redefine it.

### 2. Renderer owns presentation and workflow orchestration

The renderer should own:

- dialog visibility
- local ephemeral UI state
- task-level interaction flow
- composing canonical state into user-facing views

The renderer should not become the hidden source of truth for backend-owned domains.

### 3. One authority per domain

Avoid split truth.

Bad:

- backend computes state, renderer silently recomputes a slightly different version
- multiple startup/restore paths each define their own meaning for the same thing
- UI components infer durable state from local heuristics

Good:

- one backend-owned snapshot or canonical result
- one renderer projection from that result
- one restore path keyed by stable identity

### 4. Transport is not business logic

IPC, websocket channels, browser HTTP IPC, and preload bridges are transport boundaries.

They should:

- validate
- serialize
- route
- bind channels

They should not:

- own domain policy
- quietly mutate canonical state
- hide multi-step business workflows

### 5. UI components should consume state, not invent it

Leaf components should mostly do one of two things:

1. render a passed-in view model
2. manage local ephemeral UI state for the current screen/dialog

They should not become accidental policy engines.

If a component starts deciding durable task semantics, review freshness, or backend truth, the ownership is probably wrong.

### 6. Persistence and restore must be explicit and exact

Startup and restore bugs are usually caused by fuzzy identity.

Prefer:

- exact file identity over "newest matching file"
- explicit category registration over ad hoc startup listeners
- replayable snapshots over best-effort local reconstruction

### 7. Tests should prove the right layer

Test the backend at the backend layer.
Test renderer behavior at the renderer layer.
Test cross-layer behavior at the seam.

Do not rely on accidental test-environment state, implicit timers, or suite order.

### 8. Runtime shells should compose, not reinterpret

Electron, browser/server mode, and remote/mobile mode should adapt runtime behavior without redefining domain ownership.

That means:

- different transports are acceptable
- different platform affordances are acceptable
- different domain truths are not

### 9. Prefer explicit state machines and named workflows over scattered sequencing

Lifecycle-heavy code should be concentrated in:

- workflow modules
- bootstrap/session controllers
- explicit reducers or state machines

Not spread across handlers, stores, and components.

### 10. Local heuristics are allowed only when they stay local

Some UI surfaces need local heuristics:

- prompt affordances
- terminal focus handling
- transient input behavior
- scroll/selection state

That is fine as long as those heuristics do not become canonical truth for tasks, supervision, review, or git state.

## Layer Responsibilities

### Backend mutation/query layer

Examples:

- `electron/ipc/git-mutation-ops.ts`
- `electron/ipc/git-diff-ops.ts`
- `electron/ipc/plans.ts`
- `electron/ipc/task-ports.ts`
- `electron/ipc/agent-supervision.ts`

Owns:

- git commands and parsing
- process spawning and output capture
- filesystem watching and reads
- PTY state
- preview target verification
- canonical backend snapshots and events

Do not:

- embed renderer UX policy
- encode dialog behavior
- make UI visibility decisions

### IPC / handler boundary

Examples:

- `electron/ipc/task-git-handlers.ts`
- `electron/ipc/system-handlers.ts`
- `electron/ipc/register.ts`
- `server/browser-server.ts`

Owns:

- argument validation
- request/response mapping
- channel binding
- runtime-shell adaptation

Do not:

- own multi-step product workflows
- compute durable domain meaning that belongs lower
- duplicate projection logic that belongs higher

### Renderer workflow / app layer

Examples:

- `src/app/task-workflows.ts`
- `src/app/desktop-session.ts`
- `src/app/task-convergence.ts`
- `src/app/task-ports.ts`

Owns:

- user-intent workflows
- startup/restore orchestration
- applying backend snapshots/events to client state
- task-level behavior composition

Do not:

- reach around the backend to recreate backend truth
- move filesystem or git logic into the renderer
- let dialogs become the owners of task-level policy

### Store / projection layer

Examples:

- `src/store/*`

Owns:

- client state
- persistence of renderer-owned state
- selectors and UI-facing projections

Do not:

- hide backend business logic in store mutations
- create alternate durable truth for backend-owned state

### Presentation layer

Examples:

- `src/components/TaskPanel.tsx`
- `src/components/PushDialog.tsx`
- `src/components/SidebarTaskRow.tsx`

Owns:

- layout
- rendering
- local ephemeral UI state
- UI affordances and interaction handling

Do not:

- read files directly
- compute git truth
- decide canonical supervision/review semantics
- own task-level policy that belongs one layer up

## Test layer

Owns:

- proving behavior at the correct seam
- catching cross-layer regressions
- making lifecycle assumptions explicit

Do not:

- rely on suite order
- rely on leaked fake timers
- over-mock away the seam you are trying to prove

## Dos and Don'ts

### Do

- put git, PTY, filesystem, and preview authority in the backend
- persist exact identifiers for restore
- keep transport adapters thin
- centralize multi-step flows in named workflows/controllers
- make task-level notification and visibility policy live above leaf dialogs
- add tests at the same seam where the behavior lives
- use the architecture docs to justify placement of new code

### Don't

- let a dialog own task-level completion semantics
- let a UI component infer durable backend state from local behavior
- add one-off startup listeners for a new replayable domain
- duplicate canonical state derivation in multiple layers
- move domain logic into preload/IPC transport glue
- add “just for now” restore shortcuts that bypass exact identity
- paper over ownership issues with more polling

## Review Checklist

Before merging a non-trivial change, ask:

1. What domain changed?
2. Who is the authority for that domain?
3. Did the change preserve one authority?
4. Did any transport file become a business-logic file?
5. Did any UI component become a policy owner?
6. Is restore/replay keyed by exact identity?
7. Are tests proving the behavior at the right seam?
8. Would a future contributor know where to extend this behavior?

For upstream sync work, also ask:

9. Was the upstream change classified before coding?
10. Was the behavior mapped to the correct local owner rather than copied by file shape?
11. Do the tests validate the local seam where the behavior now lives?

If any answer is unclear, the placement is probably wrong.

## Recent Examples

### Good alignment: exact plan restore

- backend watches and reads plan files
- renderer persists exact `planRelativePath`
- startup restore uses explicit IPC to fetch the exact file

Why it aligns:

- backend owns filesystem truth
- restore uses stable identity
- renderer does not guess

### Good alignment: binary diff handling

- backend detects binary files during diff generation
- renderer receives a safe canonical result

Why it aligns:

- git/file authority stays in the backend
- UI does not interpret malformed pseudo-diffs

### Good alignment: streamed push output

- backend owns `git push --progress`
- handler binds optional output channels
- renderer workflow invokes push
- dialog owns live output UI only
- task panel owns task-level notification policy

Why it aligns:

- transport stays transport
- task-level semantics stay above the dialog
- process execution stays in the backend

## Relationship To Other Docs

- Start here for design intent:
  - `docs/ARCHITECTURAL-PRINCIPLES.md`
- Use this for current runtime/data flow:
  - `docs/ARCHITECTURE.md`
- Use this for upstream sync and porting strategy:
  - `docs/UPSTREAM-DIVERGENCE.md`
- Use this for testing strategy and coverage guidance:
  - `docs/TESTING.md`

If these documents disagree, prefer:

1. this principles document for ownership and layering rules
2. the architecture walkthrough for current implementation details
3. the testing guide for validation strategy
