# Upstream Divergence Playbook

This document explains how Parallel Code has diverged from the upstream repository and how to port upstream changes without reintroducing architecture churn.

Use it when:

1. reviewing upstream commits
2. deciding whether to cherry-pick, manually port, or reimplement a change
3. mapping an upstream file change onto this repo's newer architecture
4. explaining why a direct cherry-pick is the wrong tool even when the product behavior is still desirable

Read [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) first for the ownership rules. Use this document for the practical "how do we migrate upstream work into this fork?" playbook.

## Why This Fork Diverged

This fork did not diverge accidentally. It diverged to support a stricter architecture and runtime model:

- backend-owned canonical state for more domains
- stronger browser/server parity
- more explicit runtime controllers and workflows
- stricter startup, restore, replay, and persistence semantics
- better reliability, scenario coverage, and test hardening
- clearer boundaries between transport, workflow, store, and UI

That means some upstream changes still map cleanly, but many should now be ported by intent rather than by file shape.

## The Core Divergence

In upstream, useful behavior sometimes still lands in large UI components, broad IPC files, or older startup wiring.

In this repo, the direction is:

- backend owns external truth
- handlers validate and route
- workflow/app modules coordinate multi-step behavior
- store projects canonical state into UI-facing models
- components present and manage local ephemeral UI state

The same feature may therefore live in different files here even when the user-facing behavior is the same.

## Important Practical Difference

This repo currently uses:

- `origin` as the upstream read-only repository
- `fork` as the writable remote

That matters because upstream sync work should be reviewed against our architecture first and then pushed to `fork`, not blindly mirrored onto `origin`.

## High-Level Architectural Deltas From Upstream

### 1. More backend-owned canonical state

Compared with upstream, this repo moved more durable truth into backend-owned state and replayable snapshots, especially around:

- review and convergence
- supervision and attention
- task ports and preview trust
- browser restore/bootstrap categories

Porting rule:

- if upstream computes durable truth in the renderer, prefer moving that meaning into the backend or into an existing canonical snapshot path here

### 2. Browser/server mode is more first-class

Compared with upstream, browser mode here is not an afterthought. It has:

- explicit control-plane state
- explicit startup/replay logic
- stronger auth/session hardening
- stricter preview trust rules

Porting rule:

- any upstream change that touches transport, startup, replay, preview, or auth must be checked against browser mode explicitly, not just Electron

### 3. Workflow/controller layers are more explicit

Compared with upstream, this repo intentionally pulled multi-step behavior into named workflow and controller modules.

Porting rule:

- if upstream adds multi-step logic in a component, store slice, or IPC handler, port it into an existing workflow/controller first and wire the UI to that

### 4. Restore and persistence are stricter

This repo prefers:

- exact identities
- explicit registration
- replay/snapshot semantics

over:

- newest-file heuristics
- ad hoc startup listeners
- best-effort local reconstruction

Porting rule:

- upstream restore changes should be mapped onto exact identifiers and existing bootstrap/session logic here

### 5. Reliability and test hardening are stricter

This repo has more explicit expectations around:

- fake timer cleanup
- watcher timing
- scenario reliability
- integration test stability

Porting rule:

- upstream test additions often need to be adapted so they prove the seam without depending on suite order or leaked timer state

## Decision Matrix For Upstream Commits

When an upstream commit arrives, classify it before touching code.

### 1. Cherry-pick directly

Use when:

- the change is isolated
- file ownership still matches in this repo
- it does not cross a divergence hotspot
- it does not move durable truth into the wrong layer

Typical examples:

- styling-only changes
- isolated dialog layout fixes
- local input/paste UI fixes

### 2. Manual port

Use when:

- the behavior is clearly correct
- the file paths differ
- the ownership model is still compatible after adaptation

Typical examples:

- small watcher fixes
- backend parsing fixes
- dialog UX behavior that needs to be applied to a renamed or refactored component

### 3. Reimplement on our architecture

Use when:

- upstream behavior is good but implemented through older structure
- the change crosses workflow/controller boundaries here
- the upstream file is now split across backend, handler, workflow, store, and UI layers in this repo

Typical examples:

- push/merge/review flows
- startup/restore behavior
- preview or task-port behavior
- review queue / convergence behavior

### 4. Skip or defer

Use when:

- the change conflicts with our architectural direction
- it assumes older UI/state shape
- it would add a lot of churn for limited value
- we need a separate local design first

Typical examples:

- large feature clusters built on old dialog/review internals
- hook or CI changes that are not actually shippable in this repo yet

## Port By Intent, Not By File Shape

The most important rule is:

**port the behavioral intent, not the upstream file layout**

Examples:

- upstream touches one giant git IPC file
  here the same behavior may belong across:
  - `electron/ipc/git-mutation-ops.ts`
  - `electron/ipc/task-git-handlers.ts`
  - `src/app/task-workflows.ts`
  - `src/components/*`

- upstream touches startup behavior in a top-level app file
  here the same behavior may belong in:
  - `src/app/desktop-session.ts`
  - `src/runtime/browser-session.ts`
  - `server/browser-control-plane.ts`

- upstream touches review/diff UI logic
  here the same behavior may need to pass through:
  - backend diff/review state
  - app projection
  - presentation-only components

## Mapping Guide: Common Upstream Areas To Local Homes

### Git mutations and long-running git actions

If upstream changes:

- `electron/ipc/git.ts`
- push / merge / commit / discard flows

Look here first:

- `electron/ipc/git-mutation-ops.ts`
- `electron/ipc/task-git-handlers.ts`
- `electron/ipc/git-status-workflows.ts`
- `src/app/task-workflows.ts`

### Plan discovery, watching, and restore

If upstream changes:

- plan watcher logic
- startup plan restore
- plan persistence

Look here first:

- `electron/ipc/plans.ts`
- `electron/ipc/system-handlers.ts`
- `src/app/desktop-session.ts`
- `src/store/persistence.ts`
- `src/store/tasks.ts`

### Diff and binary handling

If upstream changes:

- diff generation
- pseudo-diff rendering
- binary-file handling

Look here first:

- `electron/ipc/git-diff-ops.ts`
- `electron/ipc/git-binary.ts`
- `src/lib/diff-parser.ts`

### Push/review/merge dialog behavior

If upstream changes:

- live progress UI
- completion notifications
- dialog visibility semantics

Look here first:

- workflow/app layer for execution
- task-level component for policy
- leaf dialog for local streaming or display state

For push specifically:

- `electron/ipc/git-mutation-ops.ts`
- `electron/ipc/task-git-handlers.ts`
- `src/app/task-workflows.ts`
- `src/components/TaskPanel.tsx`
- `src/components/PushDialog.tsx`

### Runtime startup, replay, and restore

If upstream changes:

- startup hydration
- browser bootstrap
- replayable state categories
- reconnect behavior

Look here first:

- `src/app/desktop-session.ts`
- `src/runtime/server-sync.ts`
- `src/runtime/browser-session.ts`
- `server/browser-control-plane.ts`

### Supervision and task presentation

If upstream changes:

- task row status
- attention state
- supervision snapshots
- multi-agent presentation

Look here first:

- `electron/ipc/agent-supervision.ts`
- `src/app/task-presentation-status.ts`
- `src/app/task-attention.ts`
- `src/components/SidebarTaskRow.tsx`

## Divergence Hotspots

These are the files where a direct upstream cherry-pick is most likely to be wrong:

- `src/app/desktop-session.ts`
- `src/runtime/server-sync.ts`
- `server/browser-control-plane.ts`
- `electron/ipc/agent-supervision.ts`
- `electron/ipc/task-git-handlers.ts`
- `src/app/task-workflows.ts`

If an upstream commit touches one of these areas conceptually, slow down and port by intent.

## Porting Workflow

For every upstream change, follow this sequence:

1. Identify the behavioral intent.
2. Classify the change:
   - direct cherry-pick
   - manual port
   - reimplement
   - skip/defer
3. Map the affected domain to the correct local layer owner.
4. Port the smallest behaviorally complete slice.
5. Review the result against:
   - `docs/ARCHITECTURAL-PRINCIPLES.md`
   - this divergence playbook
6. Add or adapt tests at the seam where the behavior now lives.
7. Prefer a logical commit boundary that explains the port clearly.

## Do / Don't For Upstream Migration

### Do

- map upstream behavior to local ownership first
- preserve backend authority for external state
- preserve exact restore identity
- keep task-level policy above leaf dialogs
- move transport details out of presentation components
- treat browser mode as a first-class runtime when porting
- add tests where the ported behavior actually lives

### Don't

- cherry-pick large feature stacks blindly because the UI looks similar
- move backend truth back into the renderer
- let a dialog own task-level success/failure semantics
- put workflow logic into transport glue
- reintroduce one-off startup listeners for replayable state
- force upstream hook policy into this repo if the repo baseline does not actually support it yet

## Worked Examples From Recent Ports

### Example: plan watcher and exact plan restore

Commits:

- `4272366` `feat(plan): watch and restore exact generated plan files`

Why this was a manual port instead of a cherry-pick:

- upstream startup ownership differed
- this repo already had stricter persistence and desktop-session restore flow

How it was aligned here:

- backend watcher stayed in `electron/ipc/plans.ts`
- exact identity persisted as `planRelativePath`
- startup restore flowed through explicit IPC and `src/app/desktop-session.ts`

Principles applied:

- backend owns filesystem truth
- restore uses exact identity
- renderer does not guess

### Example: binary diff detection

Commits:

- `0bb2e17` `fix(diff): detect binary files in generated diffs`

Why this was aligned:

- binary detection was moved to the backend diff layer
- renderer only consumed canonical safe diff results

Principles applied:

- backend owns git/file truth
- UI does not reinterpret malformed pseudo-diff content

### Example: streamed push output

Commits:

- `b8b83cc` `feat(push): stream live git push output`

Why this needed reimplementation instead of a direct cherry-pick:

- upstream push logic assumed older IPC and dialog structure
- this repo already split git mutation, handler, workflow, and presentation ownership

How it was aligned here:

- backend owns `git push --progress`
- handler binds optional output channel
- workflow owns transport-facing channel creation
- `TaskPanel.tsx` owns task-level completion notification policy
- `PushDialog.tsx` owns only local output rendering and close/cancel UI

Principles applied:

- transport is not business logic
- leaf dialogs do not own task-level policy
- backend owns long-running process execution

### Example: hook parity

Commits:

- `54a4499` `chore(checks): mirror CI in pre-push and ignore vendored Hydra`

Why this was not a direct upstream copy:

- the repo baseline initially could not support a full `npm run check` gate because vendored Hydra was outside our local lint/format policy
- putting `npm run check` into `pre-commit` would also have been too heavy

How it was aligned here:

- `pre-commit` stays fast and staged-file focused
- `pre-push` mirrors the real repo-quality gate
- vendored Hydra is explicitly excluded from local repo-quality baselines

Principles applied:

- repo policy should match real ownership
- external vendored code is not treated as locally maintained source

## Review Checklist For Future Upstream Ports

Before merging a ported upstream change, ask:

1. Did we port the behavior or just the file shape?
2. Who owns the changed domain here?
3. Did the port preserve one authority?
4. Did any component pick up transport or durable domain logic?
5. Did any transport/handler file start owning workflow logic?
6. Did restore/persistence stay exact?
7. Did we account for browser mode if the change crosses runtime boundaries?
8. Are tests proving the behavior at the right seam?
9. Would the commit message explain the port clearly to a future sync pass?

## Relationship To Other Docs

- ownership and layering rules:
  - `docs/ARCHITECTURAL-PRINCIPLES.md`
- current runtime/data-flow walkthrough:
  - `docs/ARCHITECTURE.md`
- test strategy:
  - `docs/TESTING.md`

If these documents disagree, prefer:

1. `ARCHITECTURAL-PRINCIPLES.md` for ownership rules
2. `UPSTREAM-DIVERGENCE.md` for porting strategy
3. `ARCHITECTURE.md` for current implementation shape
4. `TESTING.md` for validation guidance
