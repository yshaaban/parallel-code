# Architecture Alignment Plan

This document is the execution spec for the next architecture-quality pass.

It focuses on closing the remaining contradictions between the current design
principles and the actual implementation. It is intentionally narrower than a
general roadmap. The goal is to make the existing product loop more coherent,
more reliable, and harder to break:

1. server-owned state should be server-authoritative when practical
2. shared concepts should have one canonical derivation
3. runtime adapters should translate transport/runtime concerns, not quietly own
   policy
4. reconnect, startup, and restore behavior should be explicit and consistent
   across runtimes

This plan addresses five specific implementation mismatches:

1. git-derived review UI still bypasses server-authoritative ownership
2. supervision is duplicated across backend and frontend
3. convergence is still a client projection over pulled backend data
4. startup/session coordination still carries too much policy
5. browser and Electron still restore server-owned state differently

## Desired End State

By the end of this plan:

- review/convergence state is backend-owned, pushed, and replayable
- task-dot and attention semantics share one canonical supervision model
- the most important desktop startup and restore flows are driven by explicit
  bootstrap/replay contracts instead of ad hoc sequencing
- browser and Electron consume the same categories of replayable state through
  different transports but equivalent semantics
- product screens like review, sidebar queue, and attention inbox consume
  projections instead of owning refresh policy

## Non-Goals

This phase should not:

- replace the current transport architecture again
- make full file-diff payloads replayable by default
- eliminate all polling everywhere in one pass
- rewrite the entire store into reducers or events
- force perfect symmetry between browser and Electron internals when the runtime
  surfaces are genuinely different

## Workstream 1: Canonical Server-Owned Review And Convergence State

This workstream addresses items 1 and 3 directly.

### Problem

The current review/convergence experience is split:

- `src/app/task-convergence.ts` derives review readiness from multiple backend
  IPC calls
- `src/components/ChangedFilesList.tsx` and
  `src/components/ReviewPanel.tsx` still own refresh behavior for git-derived
  review state
- browser and Electron both end up with correct-enough results, but the
  freshness model is not as canonical as git status, task ports, or supervision

This is the main remaining contradiction in the architecture.

### Target Design

Introduce a backend-owned `TaskConvergenceSnapshot` lifecycle that is:

- computed by the backend
- pushed when relevant git/task lifecycle changes occur
- replayed to reconnecting browser clients
- hydrated explicitly in Electron on startup
- consumed by a thin frontend projection/store layer

Important scope boundary:

- convergence summaries, readiness, overlap, and review queue state become
  server-owned
- full per-file diff content stays on-demand and user-driven
- changed-file list freshness should be driven by convergence/review snapshot
  invalidation, not by component-owned polling

### Backend Tasks

1. Add a backend convergence service or workflow-owned state module.
   Suggested file:
   - `electron/ipc/task-convergence-state.ts`

   Responsibilities:
   - compute canonical `TaskConvergenceSnapshot`
   - maintain latest snapshot per task
   - recompute overlap warnings per project
   - remove snapshots on task deletion
   - emit state changes only when snapshots materially change

2. Move convergence derivation out of `src/app/task-convergence.ts`.
   Keep a frontend adapter/projection, but stop deriving convergence by issuing
   multiple IPC reads from the desktop app.

3. Add backend update triggers for convergence:
   - git watcher updates
   - commit / discard / rebase / merge / push workflows
   - task creation / deletion
   - branch/worktree lifecycle changes

4. Add an explicit renderer/browser event contract for convergence updates.
   Suggested event:
   - `IPC.TaskConvergenceChanged`

5. Add replay support in browser mode.
   Targets:
   - `server/browser-control-plane.ts`
   - `server/browser-server.ts`

6. Add Electron hydration support.
   Targets:
   - `electron/ipc/register.ts`
   - `src/app/desktop-session.ts`

### Frontend Tasks

1. Reduce `src/app/task-convergence.ts` into a projection/update adapter over
   pushed server snapshots.

2. Stop `src/components/ChangedFilesList.tsx` and
   `src/components/ReviewPanel.tsx` from owning refresh policy for git-derived
   review state.

   Replace component-owned polling with:
   - pushed convergence refresh for summary/readiness
   - targeted on-demand fetch for full diff payloads
   - targeted refetch of changed file list only when the backend signals
     relevant review-state change

3. Update:
   - `src/components/sidebar/SidebarReviewQueue.tsx`
   - `src/components/SidebarTaskRow.tsx`
   - `src/components/ReviewPanel.tsx`
     to consume pushed convergence state as the primary source of readiness and
     overlap.

### Validation Criteria

Implementation is complete when:

- no convergence snapshot is derived by issuing four IPC calls from the desktop
  app
- review queue freshness is driven by pushed convergence updates
- browser reconnect restores latest convergence state without manual review
  refresh
- Electron startup hydrates convergence state before screens rely on it
- deleting a task removes its convergence snapshot and overlap warnings

### Tests

Add or update:

- backend tests for convergence recomputation and overlap invalidation
- browser control-plane replay tests for convergence
- Electron desktop startup tests for initial convergence hydration
- Solid screen tests proving review queue and review panel update from pushed
  convergence state

Suggested files:

- `electron/ipc/task-convergence-state.test.ts`
- `server/browser-control-plane.test.ts`
- `src/app/desktop-session.test.ts`
- `src/components/ReviewPanel.test.tsx`
- `src/components/Sidebar.test.tsx`

## Workstream 2: Canonical Supervision And Task Presentation Status

This workstream addresses item 2 directly.

### Problem

We now have two useful but partially independent models:

- backend agent supervision in `electron/ipc/agent-supervision.ts`
- frontend task/agent status heuristics in `src/store/taskStatus.ts`

That means:

- the attention inbox is server-authoritative
- task dots and some prompt/idle behavior still depend on mounted terminal
  output analysis in the renderer

This creates semantic drift risk between:

- inbox attention
- task-dot status
- prompt readiness UI

### Target Design

Split the problem into two layers:

1. backend-owned supervision state
   - waiting for input
   - idle at prompt
   - quiet
   - failed
   - paused / restoring / flow-controlled

2. frontend presentation mapping
   - one canonical mapping from backend supervision + backend lifecycle + git
     state into:
     - task dot status
     - attention inbox labels
     - prompt-focus suggestions

Renderer prompt-tail analysis should remain only where it is genuinely local UI
behavior, such as:

- one-shot prompt detection for local prompt dispatch
- terminal-specific affordances that do not claim to be global task status

### Backend Tasks

1. Confirm `electron/ipc/agent-supervision.ts` owns all global supervision
   states used by the product.

2. If needed, extend supervision snapshots to include any missing signal needed
   by task dots or focus routing.

3. Keep supervision updates replayable in:
   - browser control plane
   - Electron renderer event flow

### Frontend Tasks

1. Introduce a canonical presentation mapping helper.
   Suggested file:
   - `src/app/task-presence.ts` or `src/app/task-presentation-status.ts`

   Responsibilities:
   - map backend supervision + backend lifecycle + git status into:
     - task-dot status
     - task attention priority
     - default focus panel for inbox/navigation

2. Reduce `src/store/taskStatus.ts` so it no longer claims global ownership of
   waiting/ready semantics from local terminal tails.

3. Keep local prompt detection only for:
   - `onAgentReady(...)`
   - terminal-local optimizations
   - prompt UX that is explicitly local, not task-global

4. Update:
   - `src/components/AttentionInbox.tsx`
   - `src/components/SidebarTaskRow.tsx`
   - any task-dot rendering surfaces
     to consume the same canonical presentation mapping.

### Validation Criteria

Implementation is complete when:

- there is one obvious place that defines task-dot semantics
- attention inbox and task dots cannot disagree on a paused / failed /
  waiting-input state
- mounted terminal output is no longer required for a task to look “waiting” or
  “ready” globally
- local prompt detection remains only for local UX, not global status ownership

### Tests

Add or update:

- backend supervision transition tests
- frontend projection tests for task-dot vs inbox alignment
- screen tests ensuring task row badges and attention inbox stay consistent

Suggested files:

- `electron/ipc/agent-supervision.test.ts`
- `src/app/task-attention.test.ts`
- new `src/app/task-presentation-status.test.ts`
- `src/components/Sidebar.test.tsx`
- `src/components/AttentionInbox.test.tsx`

## Workstream 3: Session And Restore Contract Alignment

This workstream addresses items 4 and 5 directly.

### Problem

The lifecycle code is much better than before, but still has two issues:

1. `src/app/desktop-session.ts` and `src/runtime/server-sync.ts` still carry a
   lot of startup and repair policy
2. browser and Electron restore server-owned state differently:
   - browser uses replayable control-plane state
   - Electron hydrates with discrete IPC reads + pushed updates afterward

That asymmetry is maintainable today, but it makes startup/reconcile behavior
more fragile than it should be.

### Target Design

Define a shared conceptual bootstrap contract for server-owned state:

- initial snapshot
- subsequent pushed updates
- reconnect / restore semantics

Browser and Electron can keep different transports, but they should restore the
same categories of state in the same conceptual order.

Target bootstrap categories:

- remote status
- git status / git-derived review state
- supervision
- task ports
- convergence

### Backend Tasks

1. Add a typed initial server-state snapshot contract for Electron startup.
   Suggested concept:
   - `InitialRendererServerState`

   It does not need to be one giant always-on event, but it should be one
   explicit boundary type.

2. Align the set of replayed browser control-plane state with the set of
   Electron startup-hydrated state.

3. Avoid hiding startup state repair in many places. Prefer:
   - one hydration pass
   - one push/update path

### Frontend Tasks

1. Reduce `src/app/desktop-session.ts` to:
   - register listeners early
   - buffer early events during boot
   - hydrate initial server-owned state
   - flush buffered events through canonical adapters

   It should not also be the place where many feature-specific policies are
   invented.

2. Reduce `src/runtime/server-sync.ts` to explicit synchronization policy:
   - browser state sync scheduling
   - lifecycle reconciliation
   - explicit state-machine transitions

3. Make startup-gate logic symmetrical across server-owned state categories:
   - git
   - supervision
   - task ports
   - remote status
   - convergence

4. Document the restore contract explicitly in `docs/ARCHITECTURE.md` once the
   implementation is in place.

### Validation Criteria

Implementation is complete when:

- browser and Electron both hydrate the same categories of server-owned state
- startup buffering semantics are consistent across those categories
- reconnect/reload behavior is boring and predictable
- `desktop-session.ts` reads as coordination, not feature policy accumulation
- `server-sync.ts` state transitions are explicit and covered

### Tests

Add or update:

- startup buffering tests per server-owned state category
- browser reconnect / replay scenario tests
- Electron startup hydration tests
- disposal-before-boot-complete tests
- direct sync overlap and queued follow-up tests in `server-sync`

Suggested files:

- `src/app/desktop-session.test.ts`
- `src/runtime/server-sync.test.ts`
- browser-mode scenario tests under `tests/`

## Cross-Cutting Type Hardening

These changes should be applied while implementing the workstreams above.

### Goals

- make missing event handling harder to write
- make state-machine drift visible at compile time
- reduce late `unknown` narrowing at runtime boundaries

### Tasks

1. Add or extend typed event maps for any new convergence/bootstrap events.
2. Use `satisfies`-checked handler tables where the message domain is closed.
3. Prefer discriminated unions for bootstrap and replay state.
4. Use `assertNever(...)` on state-machine and status mapping helpers.
5. Keep stronger type constraints on lifecycle-critical modules first.

### Validation Criteria

- new state categories cannot be added without compile-time pressure in the
  relevant dispatch and mapping code
- startup/restore reducers are exhaustive
- event payload types are centralized, not copied ad hoc

## Rollout Order

This should not land as one giant commit.

Recommended order:

1. Workstream 1 backend convergence state + event contract
2. Workstream 1 frontend convergence adoption
3. Workstream 2 canonical task presentation mapping
4. Workstream 3 shared bootstrap/restore contract alignment
5. follow-up type hardening and doc cleanup

## Suggested Commit Boundaries

1. `Make convergence server-authoritative`
2. `Drive review surfaces from pushed convergence state`
3. `Unify supervision and task presentation status`
4. `Align Electron and browser startup state restoration`
5. `Tighten typed bootstrap and replay boundaries`

## Review Checklist

Before each commit, verify:

1. Does this move state ownership toward the server when the server is already
   responsible for it?
2. Does this reduce, rather than increase, component-owned refresh policy?
3. Does this create a clearer single source of truth for status semantics?
4. Does this make startup/reconnect behavior easier to explain?
5. Does this add tests for the new contract rather than only the helper calls?

## Final Acceptance Criteria

This plan is complete when all of the following are true:

1. review queue and review summary state are backend-owned, pushed, and restored
2. changed-files/review surfaces no longer poll as the primary ownership model
3. task-dot and attention semantics share one canonical supervision/presentation
   model
4. `desktop-session.ts` and `server-sync.ts` have explicit, bounded
   coordination roles
5. browser and Electron restore the same categories of server-owned state with
   comparable semantics
6. the architecture doc can describe these flows without hand-waving about
   exceptions

## Why This Matters

This is not an abstract cleanup pass.

It directly protects the product goals:

- users should not have to guess whether review data is fresh
- users should not see one surface say “waiting” while another says “ready”
- startup and reconnect should not feel probabilistic
- Electron and browser mode should differ by transport, not by whether state is
  coherent

This is the next architecture-quality phase that makes the existing product more
trustworthy without restarting the architecture effort from scratch.
