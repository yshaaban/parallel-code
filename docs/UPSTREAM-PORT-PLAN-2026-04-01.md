# Upstream Port Plan 2026-04-01

This document turns the `2026-04-01` upstream review into an execution plan.

Use it together with:

- [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md)
- [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md)
- [UPSTREAM-CATCHUP-2026-04-01.md](./UPSTREAM-CATCHUP-2026-04-01.md)
- [REVIEW-RULES.md](./REVIEW-RULES.md)
- [TESTING.md](./TESTING.md)

The rule for every family is the same:

1. classify the upstream change
2. map it to the correct local owner
3. define local acceptance criteria
4. implement on our architecture rather than by upstream file shape
5. validate at the correct seam
6. update the upstream ledger when parity status changes

## Execution Order

1. Phase 0: docs and execution plan
2. Phase 1: git correctness and changed-files footer correctness
3. Phase 2: markdown and terminal-link hardening
4. Phase 3: terminal media and ergonomics improvements
5. Phase 4: UI ergonomics improvements
6. Phase 5: isolation-model redesign as a spec-first local implementation
7. Phase 6: deferred investigation tracks

## Current Status

- Phase 0: complete
- Phase 1: complete and validated on local owners/seams
- Phase 2: complete and validated on local owners/seams
- Phase 3: complete and validated on local owners/seams
- Phases 4-6: planned

## Family Spec Template

Each upstream family should be captured with:

1. upstream commits
2. behavioral intent
3. classification
4. local owner
5. validation seam
6. current-main gap
7. acceptance criteria
8. non-goals
9. likely local files
10. required doc updates

## Phase 1: Git Correctness And Changed-Files Footer

Status: completed locally on `2026-04-01` with backend merge-base diff/log/status ports, branch-mismatch merge guards, changed-files footer corrections, and passing backend/UI validation.

### Upstream commits

- `c40d743`
- `23ae2bb`
- `246ef40`
- `777f1d7`
- `c42b921`

### Behavioral intent

- branch diff stats should use merge-base semantics
- worktree status and branch log should use merge-base semantics
- merge should fail safely when the requested task branch does not match the worktree's actual branch
- changed-files footer totals should count committed diff lines only
- changed-files footer should still show uncommitted file counts when all visible files are uncommitted

### Classification

- `manual port`

### Local owner

- backend
- presentation

### Validation seam

- `node / backend`
- `Solid / UI`

### Historical current-main gap at planning time

Closed in the Phase 1 port. The local owners now use merge-base-aware git status/log/diff paths, block stale branch merges before side effects, and keep changed-files footer totals committed-only while still surfacing uncommitted counts.

### Acceptance criteria

- merge stats reflect merge-base reality instead of two-dot inflation
- branch log and worktree status reflect merge-base reality
- merge refuses stale branch context before checkout/merge side effects
- changed-files footer totals exclude uncommitted files
- changed-files footer shows uncommitted count whenever `uncommittedCount > 0`

### Non-goals

- no UI-owned branch repair policy
- no store-owned git truth
- no upstream file-shape parity port through broad git/UI rewrites

### Likely local files

- `electron/ipc/git-mutation-ops.ts`
- `electron/ipc/git.ts`
- `src/ipc/types.ts`
- `src/components/MergeDialog.tsx`
- `src/components/ChangedFilesList.tsx`
- related node and Solid tests

### Required doc updates after landing

- `docs/UPSTREAM-DIVERGENCE.md`
- `docs/UPSTREAM-CATCHUP-2026-04-01.md`
- `docs/REVIEW-RULES.md` if the port reveals a reusable git-review rule

## Phase 2: Markdown And Terminal-Link Hardening

Status: completed locally on `2026-04-01` through the shared safe markdown renderer, inline plan panel adoption, and terminal-session modifier-click link activation with targeted markdown/viewer/session validation.

### Upstream commits

- `0bc4d65` subset
- `933931a`
- revisit later within the same arc:
  - `9ce6abe`
  - `a37b958`
  - `e56a9fc`

### Behavioral intent

- markdown should render through a sanitized path
- terminal links should not open on plain click
- explicit modifier-click behavior should be consistent and tested
- markdown file links should route into an owned local viewer path when supported

### Classification

- `reimplement on our architecture`

### Local owner

- presentation
- workflow / app

### Validation seam

- `Solid / UI`
- `runtime / integration`

### Historical current-main gap at planning time

Closed in the Phase 2 port. The local markdown owners now render through the shared safe renderer, the inline plan panel no longer parses raw markdown ad hoc, and terminal web links require explicit modifier intent at the terminal-session owner.

### Acceptance criteria

- untrusted markdown cannot inject active unsafe markup through owned render paths
- terminal links require explicit user intent
- markdown link handling remains routed through shared owners rather than leaf component ad hoc policy

### Non-goals

- no copy of upstream terminal component shape
- no renderer-local reinvention of backend or workflow truth

### Likely local files

- `src/lib/marked-shiki.ts`
- `src/components/PlanViewerDialog.tsx`
- terminal session/link handling owners
- related UI and runtime tests

### Required doc updates after landing

- `docs/UPSTREAM-DIVERGENCE.md`
- `docs/UPSTREAM-CATCHUP-2026-04-01.md`
- `docs/ARCHITECTURE.md`
- `docs/REVIEW-RULES.md`
- `docs/TESTING.md` if gate expectations change

## Phase 3: Terminal Media And Ergonomics

Status: completed locally on `2026-04-01` through the typed clipboard-image IPC seam, Electron-owned temp-file save path, explicit browser fallback, and terminal-session shortcut-policy integration with targeted backend/helper/session validation.

### Upstream commits

- `cec983b`
- `774ffe2`
- optionally the minimum permission subset from `7a9565b` if needed

### Behavioral intent

- support terminal-friendly clipboard image paste through a typed backend seam
- adopt high-value terminal ergonomics that fit current local workflow policy

### Classification

- `reimplement on our architecture`

### Local owner

- handler / transport
- workflow / app
- presentation

### Validation seam

- `runtime / integration`
- `Solid / UI`

### Historical current-main gap at planning time

Closed in the Phase 3 port. The local handler/transport seam now exposes typed clipboard-image saving for Electron runtimes, browser mode degrades explicitly when only text paste is available, and terminal-session consumes the shared shortcut policy for both keydown sends and keyup suppression.

### Acceptance criteria

- clipboard image paste works through typed IPC or degrades explicitly when unsupported
- temp-file ownership and cleanup are defined
- any adopted shortcut behavior does not conflict with prompt or terminal ownership rules

### Non-goals

- no implicit Electron-only assumptions in browser mode
- no permission widening without a direct feature need

### Required doc updates after landing

- `docs/UPSTREAM-DIVERGENCE.md`
- `docs/UPSTREAM-CATCHUP-2026-04-01.md`
- `docs/ARCHITECTURE.md`
- `docs/TERMINAL-DEVELOPMENT-GUIDE.md`

## Phase 4: UI Ergonomics Improvements

### Upstream commits

- `7d534ce`
- `88b5b8f`
- `fb86cc5`
- optionally `a350209`
- optionally `b944064`

### Behavioral intent

- improve zoom reset reliability
- improve selector overflow handling
- improve diff readability where the local UX benefits are clear
- evaluate optional prompt-panel visibility behavior separately from parity pressure

### Classification

- `manual port`

### Local owner

- presentation
- store / projection only if durable state is intentionally added

### Validation seam

- `Solid / UI`

### Non-goals

- no broad visual churn unrelated to the reviewed behavior
- no durable UI state without an explicit product decision

## Phase 5: Isolation-Model Redesign

### Upstream commits

- `8d30d7e`
- `95d0f06`
- `2b82e88`
- `3134143`

### Behavioral intent

- replace ambiguous direct-mode semantics with an explicit isolation model
- make base-branch behavior explicit
- align backend, persistence, and UI terminology around that model

### Classification

- `reimplement on our architecture`

### Local owner

- backend
- workflow / app
- store / projection

### Validation seam

- `node / backend`
- `runtime / integration`
- `Solid / UI`

### Required precondition

Write the local isolation-model spec first. Do not start by renaming fields or cherry-picking upstream UI.

### Local spec must define

- supported isolation modes in this fork
- which durable truth is repo/project-scoped versus task-scoped
- how base branch interacts with each mode
- migration from persisted old state
- task creation, branch checkout, merge, and edit-project semantics

## Phase 6: Deferred Investigation Tracks

These are relevant but not active parity work until their local need is proven:

- font capability detection: `fc57cfd`
- terminal scroll/xterm family: `60857bd`, `e07d69d`, `0882952`
- Electron permission family: `b51c0b7`, `7a9565b`
- upstream Docker isolation family: remain deferred in favor of local backend-owned task container environments

For these tracks:

- reproduce the actual local gap first
- then decide whether to port, reimplement, or keep deferred
- record the result in the upstream ledger docs
