# Upstream Catch-up Review 2026-04-01

This document records the per-commit review of the upstream-only range on `origin/main` that is
not present on local `main`.

Scope:

- upstream branch reviewed: `origin/main`
- upstream head at review time: `91f00f4`
- previous reviewed upstream head: `4792390`
- review date: `2026-04-01`
- local head at review time: `22a5473`
- shared graph ancestor: `b250446`
- commits reviewed in range: `49`

Use this with [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md), which remains the high-level
parity ledger.

## Summary

- Upstream moved from `4792390` to `91f00f4`.
- The backend git correctness family and changed-files footer corrections landed locally:
  - `c40d743`
  - `23ae2bb`
  - `246ef40`
  - `777f1d7`
  - `c42b921`
- The markdown/link hardening slice landed locally for the current-scope commits:
  - `0bc4d65` markdown-sanitization subset
  - `933931a`
- The terminal media/input ergonomics slice landed locally:
  - `cec983b`
  - `774ffe2`
- The bounded UI ergonomics slice landed locally:
  - `7d534ce`
  - `88b5b8f`
  - `fb86cc5`
  - bounded subset of `b944064`
- The shared app-level markdown viewer and owned `.md` routing from task-note/file surfaces landed
  locally; the remaining bounded markdown/viewer queue is:
  - `9ce6abe`
  - `a37b958`
  - `e56a9fc`
  - plus optional `a350209`
- The `directMode` to `GitIsolationMode` family landed locally across store, backend,
  workflow, and the primary task surfaces, with compatibility cleanup still separate from the parity
  ledger:
  - `8d30d7e`
  - `95d0f06`
  - `2b82e88`
  - `3134143`
- The upstream Docker agent-isolation family remains intentionally deferred:
  - `0a31fb7`
  - `e96fba1`
- The upstream terminal scroll/xterm family stays deferred unless reproduced on current
  main:
  - `60857bd`
  - `e07d69d`
  - `0882952`

## Per-Commit Ledger

### Batch 1

| Commit    | Status  | Classification                    | Owner                | Seam                    | Plan                                                                                                                                                                                        |
| --------- | ------- | --------------------------------- | -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fc57cfd` | later   | `skip/defer`                      | `presentation`       | `Solid / UI`            | Local main already filters a curated font list by availability; full system-font enumeration is not a current parity target.                                                                |
| `8d30d7e` | landed  | `reimplement on our architecture` | `workflow / app`     | `runtime / integration` | Landed locally through the staged git-isolation migration: current-branch task creation is now backend/workflow-owned and follows the local contract in `docs/GIT-ISOLATION-MODEL-SPEC.md`. |
| `7d534ce` | landed  | `manual port`                     | `presentation`       | `Solid / UI`            | Landed locally in the Phase 4 UI ergonomics port through the global zoom-reset shortcut owner.                                                                                              |
| `c40d743` | landed  | `manual port`                     | `backend`            | `node / backend`        | Landed locally in the Phase 1 backend git port.                                                                                                                                             |
| `60857bd` | defer   | `reimplement on our architecture` | `workflow / app`     | `runtime / integration` | Possible terminal scroll bugfix, but the local terminal/session/fit owners have diverged enough that this should only be revisited with a reproduced bug on current main.                   |
| `88b5b8f` | landed  | `manual port`                     | `presentation`       | `Solid / UI`            | Landed locally in the Phase 4 UI ergonomics port through bounded soft-wrap diff rendering in `ScrollingDiffView.tsx`.                                                                       |
| `0882952` | defer   | `skip/defer`                      | `workflow / app`     | `runtime / integration` | Do not take an upstream xterm beta bump as parity churn without a reproduced current-main bug and full terminal browser-lab validation.                                                     |
| `cd1ad01` | covered | `reimplement on our architecture` | `workflow / app`     | `Solid / UI`            | Local `TaskPanel` is already decomposed across task-panel controllers and sections.                                                                                                         |
| `0a31fb7` | defer   | `skip/defer`                      | `backend`            | `docs / sanity only`    | Upstream Docker image maintenance remains intentionally non-parity for this web/server-first fork.                                                                                          |
| `777f1d7` | landed  | `manual port`                     | `presentation`       | `Solid / UI`            | Landed locally in the Phase 1 changed-files footer port.                                                                                                                                    |
| `e96fba1` | defer   | `skip/defer`                      | `backend`            | `docs / sanity only`    | Same deferred Docker family as `0a31fb7`.                                                                                                                                                   |
| `95d0f06` | landed  | `reimplement on our architecture` | `store / projection` | `runtime / integration` | Landed locally through explicit `defaultTaskGitIsolation`, `gitIsolation`, persistence migration, and compatibility hydration on the store/projection owner.                                |

### Batch 2

| Commit    | Status  | Classification                    | Owner            | Seam                    | Plan                                                                                                                                                  |
| --------- | ------- | --------------------------------- | ---------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fb86cc5` | landed  | `manual port`                     | `presentation`   | `Solid / UI`            | Landed locally in the Phase 4 UI ergonomics port through wrapped agent-selector layout and larger high-agent dialog sizing.                           |
| `a81d24d` | covered | `reimplement on our architecture` | `backend`        | `node / backend`        | Local branch diff context already resolves branch refs through the backend diff owners.                                                               |
| `ccd9fe5` | skipped | `skip/defer`                      | `backend`        | `docs / sanity only`    | Merge wrapper commit only.                                                                                                                            |
| `e07d69d` | defer   | `reimplement on our architecture` | `workflow / app` | `runtime / integration` | Same deferred terminal scroll-preservation family as `60857bd`.                                                                                       |
| `9333bfd` | covered | `reimplement on our architecture` | `presentation`   | `Solid / UI`            | Current `NewTaskDialog` already has arrow-key field navigation.                                                                                       |
| `cdf80e6` | covered | `manual port`                     | `workflow / app` | `Solid / UI`            | Local dialog-open initialization already resets `selectedProjectId`.                                                                                  |
| `faef5c3` | covered | `reimplement on our architecture` | `backend`        | `node / backend`        | Merge-base changed-files diff plus base-branch support are already in local git owners.                                                               |
| `63ef1da` | skipped | `skip/defer`                      | `backend`        | `docs / sanity only`    | Merge wrapper commit only.                                                                                                                            |
| `abb5d62` | skipped | `skip/defer`                      | `presentation`   | `docs / sanity only`    | Release tag only.                                                                                                                                     |
| `2b82e88` | landed  | `reimplement on our architecture` | `workflow / app` | `runtime / integration` | Landed locally through empty-base normalization, explicit `baseBranch` persistence, and backend/workflow-owned current-branch checkout orchestration. |
| `8d6e3cb` | covered | `manual port`                     | `backend`        | `node / backend`        | Local diff code already resolves refs to hashes instead of depending on raw branch names.                                                             |
| `cda05c3` | skipped | `skip/defer`                      | `backend`        | `docs / sanity only`    | Merge wrapper commit only.                                                                                                                            |

### Batch 3

| Commit    | Status  | Classification                    | Owner                 | Seam                    | Plan                                                                                                                                                                                            |
| --------- | ------- | --------------------------------- | --------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `23ae2bb` | landed  | `manual port`                     | `backend`             | `node / backend`        | Landed locally in the Phase 1 backend merge-safety port.                                                                                                                                        |
| `c42b921` | landed  | `manual port`                     | `presentation`        | `Solid / UI`            | Landed locally in the Phase 1 changed-files footer port.                                                                                                                                        |
| `0269812` | skipped | `skip/defer`                      | `backend`             | `node / backend`        | Intermediate one-way-diff behavior was superseded upstream by later merge-base work.                                                                                                            |
| `ab434ae` | skipped | `skip/defer`                      | `presentation`        | `docs / sanity only`    | Release tag only.                                                                                                                                                                               |
| `39aff3c` | covered | `manual port`                     | `store / projection`  | `Solid / UI`            | Local persistence already stores `branchName`.                                                                                                                                                  |
| `bc8a127` | skipped | `skip/defer`                      | `presentation`        | `Solid / UI`            | Theme-only addition.                                                                                                                                                                            |
| `a350209` | later   | `manual port`                     | `presentation`        | `Solid / UI`            | Prompt-input panel toggle is optional product surface, not a parity-critical gap.                                                                                                               |
| `21701eb` | skipped | `skip/defer`                      | `presentation`        | `Solid / UI`            | Theme-only addition.                                                                                                                                                                            |
| `9ce6abe` | covered | `reimplement on our architecture` | `workflow / app`      | `Solid / UI`            | The shared app-level markdown viewer and owned `.md` routing from task-note, file, and terminal surfaces are landed locally through the shared viewer and terminal-session link provider tests. |
| `38a16b5` | skipped | `skip/defer`                      | `presentation`        | `Solid / UI`            | Visual polish only.                                                                                                                                                                             |
| `774ffe2` | landed  | `reimplement on our architecture` | `presentation`        | `Solid / UI`            | Landed locally in the Phase 3 terminal-session shortcut-policy port.                                                                                                                            |
| `cec983b` | landed  | `reimplement on our architecture` | `handler / transport` | `runtime / integration` | Landed locally in the Phase 3 typed clipboard-image IPC and Electron temp-file save port.                                                                                                       |

### Batch 4

| Commit    | Status  | Classification                    | Owner                 | Seam                    | Plan                                                                                                                                                                |
| --------- | ------- | --------------------------------- | --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `246ef40` | landed  | `manual port`                     | `backend`             | `node / backend`        | Landed locally in the Phase 1 backend git port.                                                                                                                     |
| `3134143` | landed  | `reimplement on our architecture` | `presentation`        | `Solid / UI`            | Landed locally through `Current Branch` terminology across the primary task surfaces, badges, branch info, and remote presentation helpers.                         |
| `0bc4d65` | landed  | `reimplement on our architecture` | `presentation`        | `Solid / UI`            | Landed locally as a shared safe markdown renderer plus inline-plan adoption; the unrelated IPC/theme pieces remain intentionally out of scope.                      |
| `c40a5f6` | covered | `reimplement on our architecture` | `backend`             | `node / backend`        | Local one-way diff backend already computes merge-base contexts.                                                                                                    |
| `933931a` | landed  | `reimplement on our architecture` | `workflow / app`      | `runtime / integration` | Landed locally at the terminal-session owner, where terminal web links now require explicit modifier intent before opening.                                         |
| `b51c0b7` | defer   | `skip/defer`                      | `handler / transport` | `runtime / integration` | Electron microphone/clipboard permission widening is not a current parity target for this fork.                                                                     |
| `69b0a4b` | skipped | `skip/defer`                      | `presentation`        | `docs / sanity only`    | Dependency bump only.                                                                                                                                               |
| `a37b958` | covered | `reimplement on our architecture` | `workflow / app`      | `Solid / UI`            | Same bounded `.md` viewer family as `9ce6abe`: terminal `.md` links now open in the shared viewer through the terminal-session owner.                               |
| `e56a9fc` | covered | `reimplement on our architecture` | `presentation`        | `Solid / UI`            | Mermaid now renders only inside the owned `PlanViewerDialog` pipeline with explicit success, failure, and one-time initialization tests.                            |
| `7a9565b` | defer   | `skip/defer`                      | `handler / transport` | `runtime / integration` | Keep with the deferred Electron permission family.                                                                                                                  |
| `2f1d498` | skipped | `skip/defer`                      | `presentation`        | `docs / sanity only`    | Release tag only.                                                                                                                                                   |
| `b944064` | partial | `manual port`                     | `presentation`        | `Solid / UI`            | A bounded local subset landed in Phase 4: deleted-file banner, status-badge tinting, and no added-file hidden-gap fetches; broader preview polish remains optional. |
| `91f00f4` | skipped | `skip/defer`                      | `presentation`        | `docs / sanity only`    | Dependency bump only.                                                                                                                                               |

## Recommended Next Actions

1. Phase 1 is now landed locally:
   - `c40d743`
   - `23ae2bb`
   - `246ef40`
   - `777f1d7`
   - `c42b921`
2. Phase 2 is now landed locally:
   - `0bc4d65` markdown-sanitization subset
   - `933931a`
3. Phase 3 is now landed locally:
   - `cec983b`
   - `774ffe2`
4. Phase 4 is now landed locally:
   - `7d534ce`
   - `88b5b8f`
   - `fb86cc5`
   - bounded subset of `b944064`
5. Treat the remaining viewer-adjacent queue as bounded follow-up work:
   - optional prompt-panel behavior: `a350209`
   - any broader `b944064` preview polish not already covered by the landed bounded subset
6. Keep the larger redesign/defer families explicit:
   - isolation-model family: `8d30d7e`, `95d0f06`, `2b82e88`, `3134143` now has a landed local
     implementation plus the contract in `docs/GIT-ISOLATION-MODEL-SPEC.md`
   - terminal scroll/xterm family: `60857bd`, `e07d69d`, `0882952`
   - upstream Docker family: `0a31fb7`, `e96fba1`
