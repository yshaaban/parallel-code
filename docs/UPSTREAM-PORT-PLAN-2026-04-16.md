# Upstream Port Plan 2026-04-16

This document is the active execution tracker for absorbing the reviewed upstream-only range
`b250446..91f00f4` under this fork's architecture.

Use it with:

- [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [TESTING.md](./TESTING.md)
- [REVIEW-RULES.md](./REVIEW-RULES.md)
- [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md)
- [UPSTREAM-CONSOLIDATED-ACTION-PLAN-2026-04-16.md](./UPSTREAM-CONSOLIDATED-ACTION-PLAN-2026-04-16.md)

## Execution Rules

1. Implement by behavioral intent, not upstream file shape.
2. Keep backend-owned truth in backend, handlers, workflow, and store owners.
3. Do not close bug-fix families by assumption; reproduce or disprove them on current `main`.
4. Do not port Electron-local Docker or permission behavior into the browser-first default path.
5. Update this file whenever a family changes status.

## Status Legend

- `planned`
- `in_progress`
- `blocked`
- `landed`
- `not_planned`

## Master Status

| Phase | Scope                                      | Status        | Notes                                                                                                                                                                      |
| ----- | ------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Current reproducible terminal/runtime bugs | `in_progress` | The remaining blockers are the startup-large-buffer, additive-burst, and resize-flicker frame-budget cases in the browser render-stress harness, not upstream parity gaps. |
| 1     | Terminal `.md` viewer routing              | `landed`      | `.md` terminal links now route through the owned markdown viewer path in the terminal-session owner.                                                                       |
| 2     | Mermaid and bounded diff-preview polish    | `landed`      | Mermaid landed in the owned plan-viewer pipeline; the remaining bounded diff-preview behavior was already covered locally.                                                 |
| 3     | Prompt input panel toggle decision         | `not_planned` | Upstream `a350209` does not fit the current browser shell or prompt-focus model.                                                                                           |
| 4     | Narrow surviving subset from `2430b97`     | `landed`      | The surviving prompt-send, channel-lifecycle, and storage behaviors were already covered on current `main`.                                                                |
| 5     | Docker family closure                      | `not_planned` | Upstream Docker isolation stays redesign-only and is not a direct port target.                                                                                             |
| 6     | Final validation and ledger closeout       | `blocked`     | Upstream commit absorption is closed, but the broader closeout stays blocked until Phase 0 runtime work is finished.                                                       |

## Phase 0: Current Runtime Bug Closure

### Family 0A: Terminal render-stress regressions

- upstream commits: none directly; this is current-main bug work that blocks parity signoff
- local owner: terminal runtime and browser render diagnostics
- status: `in_progress`

Current evidence:

- [tests/browser/terminal-restore.spec.ts](../tests/browser/terminal-restore.spec.ts): green
- [tests/browser/terminal-scroll-fit-preservation.spec.ts](../tests/browser/terminal-scroll-fit-preservation.spec.ts): green
- focused owner-level improvements landed in:
  - `src/app/runtime-diagnostics.ts`
  - `src/app/ui-fluidity-diagnostics.ts`
  - `src/lib/terminal-output-diagnostics.ts`
  - `src/components/terminal-view/terminal-output-pipeline.ts`
- additive-burst render stress is now isolated from startup noise:
  - the fixture waits for explicit terminal input before beginning the measured burst
  - the browser case resets diagnostics before triggering that burst
  - this fixed the measurement window, but fresh rebuilt browser runs still fail the budget
    intermittently, so the runtime issue is not closed
- the render-stress recipe is now split so `resize flicker`, `additive burst`, and the remaining
  shared cases run as separate Playwright invocations
- a page-side startup-window diagnostics reset was rejected during review because it changed the
  measured startup window instead of fixing the runtime; no test-only startup reset is kept
- latest rebuilt isolated resize-flicker rerun during this review pass failed at `23 > 20`
- latest rebuilt isolated additive-burst reruns during this review pass failed at `15-16 > 12`
- latest startup-large-buffer isolated reruns remain marginal, fluctuating between pass and
  `14-16 > 12`

Known failing cases:

- `resize flicker`
- `additive burst`
- `startup large buffer`

Likely owners:

- `src/components/terminal-view/terminal-output-pipeline.ts`
- `src/lib/terminal-output-diagnostics.ts`
- `src/app/ui-fluidity-diagnostics.ts`
- `src/app/runtime-diagnostics.ts`

Acceptance criteria:

- isolated `additive burst` passes
- isolated `startup large buffer` passes
- full `tests/browser/terminal-render-stress.spec.ts` passes
- `tests/browser/terminal-restore.spec.ts` remains green
- `tests/browser/terminal-scroll-fit-preservation.spec.ts` remains green

Validation:

- `npm run test:browser:file -- tests/browser/terminal-render-stress.spec.ts --project chromium --workers=1`
- `npm run test:browser:file -- tests/browser/terminal-restore.spec.ts --project chromium --workers=1`
- `npm run test:browser:file -- tests/browser/terminal-scroll-fit-preservation.spec.ts --project chromium --workers=1`

## Phase 1: Terminal Markdown Viewer Routing

### Family 1A: Terminal `.md` links open in the owned viewer

- upstream commits:
  - `9ce6abe`
  - `a37b958`
- local owner: workflow / app + terminal session
- status: `landed`

Intent:

- terminal `.md` links should route into the shared markdown viewer path instead of falling
  through to ad hoc handling

Local files:

- `src/components/terminal-view/terminal-session.ts`
- `src/components/terminal-view/terminal-session.test.tsx`

Acceptance criteria:

- terminal `.md` links open in-app
- non-markdown link policy stays unchanged
- modifier-click remains required
- browser-first security model stays intact

Validation:

- `npm run test:solid:file -- src/components/terminal-view/terminal-session.test.tsx`
- `npm run typecheck`

## Phase 2: Markdown And Diff Presentation

### Family 2A: Mermaid in the owned plan viewer

- upstream commits:
  - `e56a9fc`
- local owner: presentation
- status: `landed`

Intent:

- Mermaid rendering should exist only in the owned plan-viewer pipeline

Local files:

- `src/components/PlanViewerDialog.tsx`
- `src/components/PlanViewerDialog.test.tsx`
- `src/lib/marked-shiki.ts`
- `src/lib/marked-shiki.test.ts`

Acceptance criteria:

- Mermaid renders in the plan viewer
- degraded unsupported paths remain readable
- markdown safety is not weakened

Validation:

- `npm run test:solid:file -- src/components/PlanViewerDialog.test.tsx`
- `npm run test:node:file -- src/lib/marked-shiki.test.ts`
- `npm run typecheck`

### Family 2B: Remaining bounded diff-preview polish

- upstream commits:
  - `b944064`
- local owner: presentation
- status: `landed`

Intent:

- confirm that the worthwhile bounded diff-preview behavior already lives in the current review
  presentation owners

Local files:

- `src/components/ScrollingDiffView.tsx`
- `src/components/ScrollingDiffView.test.tsx`

Acceptance criteria:

- no renderer-owned diff truth
- no hidden-gap regressions for added or deleted files
- no unrelated review-surface reshaping

Validation:

- `npm run test:solid:file -- src/components/ScrollingDiffView.test.tsx`

## Phase 3: Prompt Input Panel Toggle

### Family 3A: Optional prompt input panel affordance

- upstream commits:
  - `a350209`
- local owner: presentation + settings/store projection
- status: `not_planned`

Decision:

- keep the current browser-shell prompt surface intact
- do not port the upstream desktop-shaped hide-toggle affordance
- only reopen this if we intentionally redesign the task-panel shell around terminal-first columns

Acceptance criteria:

- explicit outcome recorded
- no ambiguous future parity debt remains

## Phase 4: Narrow Subset From `2430b97`

### Family 4A: Surviving prompt-send, channel-lifecycle, and storage behaviors

- upstream commits:
  - `2430b97`
- local owner: mixed; must be decomposed before implementation
- status: `landed`

Result:

- no new code was needed from this commit
- the surviving prompt-send, channel-lifecycle, storage, and persisted-agent-default behaviors are
  already covered on current `main`

Current owners checked:

- `src/components/PromptInput.tsx`
- `src/lib/ipc.ts`
- `src/lib/browser-channel-client.ts`
- `electron/ipc/storage.ts`
- `src/store/persistence-agent-defaults.ts`

Acceptance criteria:

- every imported behavior is tracked separately
- the surviving behaviors map to current owners with existing tests
- no broad structural churn was introduced

## Phase 5: Docker Family Closure

### Family 5A: Upstream Docker isolation

- upstream commits:
  - `c646df4`
  - `2be2c00`
  - `064a4ea`
  - `c456632`
  - `511af86`
  - `0a31fb7`
  - `e96fba1`
- local owner: backend redesign only, if ever pursued
- status: `not_planned`

Allowed outcomes:

- `not_planned`
- or a new architecture spec for backend-owned runner isolation

Forbidden outcome:

- direct upstream porting into Electron-shaped or client-owned container logic

Acceptance criteria:

- one explicit product decision recorded for the whole family
- current tracker and divergence docs both treat the family as redesign-only, not as deferred parity

## Phase 6: Final Closeout

### Family 6A: Parity ledger closeout

- status: `blocked`

Tasks:

- update this file with landed or closed statuses
- update [UPSTREAM-CONSOLIDATED-ACTION-PLAN-2026-04-16.md](./UPSTREAM-CONSOLIDATED-ACTION-PLAN-2026-04-16.md)
- reduce [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) to the true open queue

Acceptance criteria:

- all `bring_with_modifications` families are either `landed` or explicitly closed
- Docker family is explicit
- bug-fix families are resolved by evidence, not by assumption

## Current Validation Record

Latest confirmed evidence during this execution pass:

- `tests/browser/terminal-restore.spec.ts`: passed
- `tests/browser/terminal-scroll-fit-preservation.spec.ts`: passed
- `npm run test:solid:file -- src/components/terminal-view/terminal-session.test.tsx`: passed
- `npm run test:solid:file -- src/components/PlanViewerDialog.test.tsx`: passed
- `npm run test:solid:file -- src/components/ScrollingDiffView.test.tsx`: passed
- `npm run test:node:file -- src/lib/marked-shiki.test.ts src/lib/terminal-output-diagnostics.test.ts`: passed
- `npm run typecheck`: passed
- targeted render-stress rerun on `2026-04-16`:
  - `startup large buffer`: `14 > 12`
  - `additive burst`: `13 > 12`

This means the upstream absorption work is closed, and the remaining blocker is a current-main
render-stress budget issue rather than an unresolved upstream port.
