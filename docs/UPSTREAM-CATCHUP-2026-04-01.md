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
- The backend git correctness family and changed-files footer corrections are now landed locally:
  - `c40d743`
  - `23ae2bb`
  - `246ef40`
  - `777f1d7`
  - `c42b921`
- The next worthwhile slice is markdown/link hardening:
  - `0bc4d65` markdown-sanitization subset
  - `933931a`
  - later: `9ce6abe`, `a37b958`, `cec983b`, `e56a9fc`
- The `directMode` to `GitIsolationMode` family remains intentionally deferred as a larger local
  redesign:
  - `8d30d7e`
  - `95d0f06`
  - `2b82e88`
  - `3134143`
- The upstream Docker agent-isolation family remains intentionally deferred:
  - `0a31fb7`
  - `e96fba1`
- The upstream terminal scroll/xterm family should stay deferred unless reproduced on current
  main:
  - `60857bd`
  - `e07d69d`
  - `0882952`

## Per-Commit Ledger

### Batch 1

| Commit    | Status  | Classification                    | Owner                | Seam                    | Plan                                                                                                                                                                       |
| --------- | ------- | --------------------------------- | -------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fc57cfd` | later   | `skip/defer`                      | `presentation`       | `Solid / UI`            | Local main already filters a curated font list by availability; full system-font enumeration is not a current parity target.                                               |
| `8d30d7e` | defer   | `reimplement on our architecture` | `workflow / app`     | `runtime / integration` | Local repo-scoped base-branch support exists, but replacing `directMode` with a richer isolation model is a larger redesign.                                               |
| `7d534ce` | bring   | `manual port`                     | `presentation`       | `Solid / UI`            | Global zoom reset is still not wired as broadly as upstream; bring over the low-risk shortcut fix.                                                                         |
| `c40d743` | landed  | `manual port`                     | `backend`            | `node / backend`        | Landed locally in the Phase 1 backend git port.                                                                                                                            |
| `60857bd` | defer   | `reimplement on our architecture` | `workflow / app`     | `runtime / integration` | Plausible terminal scroll bugfix, but the local terminal/session/fit owners have diverged enough that this should only be revisited with a reproduced bug on current main. |
| `88b5b8f` | later   | `manual port`                     | `presentation`       | `Solid / UI`            | Soft-wrapped diff rendering is still missing in `ScrollingDiffView.tsx`; worth queueing as a bounded UI improvement.                                                       |
| `0882952` | defer   | `skip/defer`                      | `workflow / app`     | `runtime / integration` | Do not take an upstream xterm beta bump as parity churn without a reproduced current-main bug and full terminal browser-lab validation.                                    |
| `cd1ad01` | covered | `reimplement on our architecture` | `workflow / app`     | `Solid / UI`            | Local `TaskPanel` is already decomposed across task-panel controllers and sections.                                                                                        |
| `0a31fb7` | defer   | `skip/defer`                      | `backend`            | `docs / sanity only`    | Upstream Docker image maintenance remains intentionally non-parity for this web/server-first fork.                                                                         |
| `777f1d7` | landed  | `manual port`                     | `presentation`       | `Solid / UI`            | Landed locally in the Phase 1 changed-files footer port.                                                                                                                   |
| `e96fba1` | defer   | `skip/defer`                      | `backend`            | `docs / sanity only`    | Same deferred Docker family as `0a31fb7`.                                                                                                                                  |
| `95d0f06` | defer   | `reimplement on our architecture` | `store / projection` | `runtime / integration` | Same deferred isolation-model family as `8d30d7e`.                                                                                                                         |

### Batch 2

| Commit    | Status  | Classification                    | Owner            | Seam                    | Plan                                                                                                                                                         |
| --------- | ------- | --------------------------------- | ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fb86cc5` | later   | `manual port`                     | `presentation`   | `Solid / UI`            | Agent selector wrapping is still missing locally; useful but low urgency.                                                                                    |
| `a81d24d` | covered | `reimplement on our architecture` | `backend`        | `node / backend`        | Local branch diff context already resolves branch refs through the backend diff owners.                                                                      |
| `ccd9fe5` | skipped | `skip/defer`                      | `backend`        | `docs / sanity only`    | Merge wrapper commit only.                                                                                                                                   |
| `e07d69d` | defer   | `reimplement on our architecture` | `workflow / app` | `runtime / integration` | Same deferred terminal scroll-preservation family as `60857bd`.                                                                                              |
| `9333bfd` | covered | `reimplement on our architecture` | `presentation`   | `Solid / UI`            | Current `NewTaskDialog` already has arrow-key field navigation.                                                                                              |
| `cdf80e6` | covered | `manual port`                     | `workflow / app` | `Solid / UI`            | Local dialog-open initialization already resets `selectedProjectId`.                                                                                         |
| `faef5c3` | covered | `reimplement on our architecture` | `backend`        | `node / backend`        | Merge-base changed-files diff plus base-branch support are already in local git owners.                                                                      |
| `63ef1da` | skipped | `skip/defer`                      | `backend`        | `docs / sanity only`    | Merge wrapper commit only.                                                                                                                                   |
| `abb5d62` | skipped | `skip/defer`                      | `presentation`   | `docs / sanity only`    | Release tag only.                                                                                                                                            |
| `2b82e88` | partial | `reimplement on our architecture` | `workflow / app` | `runtime / integration` | Base-branch-aware task creation is partly covered locally, but branch-dropdown/direct-mode auto-checkout belongs with the deferred isolation-model redesign. |
| `8d6e3cb` | covered | `manual port`                     | `backend`        | `node / backend`        | Local diff code already resolves refs to hashes instead of depending on raw branch names.                                                                    |
| `cda05c3` | skipped | `skip/defer`                      | `backend`        | `docs / sanity only`    | Merge wrapper commit only.                                                                                                                                   |

### Batch 3

| Commit    | Status  | Classification                    | Owner                 | Seam                    | Plan                                                                                                                           |
| --------- | ------- | --------------------------------- | --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `23ae2bb` | landed  | `manual port`                     | `backend`             | `node / backend`        | Landed locally in the Phase 1 backend merge-safety port.                                                                       |
| `c42b921` | landed  | `manual port`                     | `presentation`        | `Solid / UI`            | Landed locally in the Phase 1 changed-files footer port.                                                                       |
| `0269812` | skipped | `skip/defer`                      | `backend`             | `node / backend`        | Intermediate one-way-diff behavior was superseded upstream by later merge-base work.                                           |
| `ab434ae` | skipped | `skip/defer`                      | `presentation`        | `docs / sanity only`    | Release tag only.                                                                                                              |
| `39aff3c` | covered | `manual port`                     | `store / projection`  | `Solid / UI`            | Local persistence already stores `branchName`.                                                                                 |
| `bc8a127` | skipped | `skip/defer`                      | `presentation`        | `Solid / UI`            | Theme-only addition.                                                                                                           |
| `a350209` | later   | `manual port`                     | `presentation`        | `Solid / UI`            | Prompt-input panel toggle is optional product surface, not a parity-critical gap.                                              |
| `21701eb` | skipped | `skip/defer`                      | `presentation`        | `Solid / UI`            | Theme-only addition.                                                                                                           |
| `9ce6abe` | later   | `reimplement on our architecture` | `workflow / app`      | `runtime / integration` | Current terminal links do not route `.md` files into a built-in viewer; worth revisiting after markdown hardening.             |
| `38a16b5` | skipped | `skip/defer`                      | `presentation`        | `Solid / UI`            | Visual polish only.                                                                                                            |
| `774ffe2` | later   | `manual port`                     | `presentation`        | `Solid / UI`            | Terminal-specific `Cmd+Arrow` behavior is still missing locally; `Shift+Enter` prompt newline is already covered.              |
| `cec983b` | later   | `reimplement on our architecture` | `handler / transport` | `runtime / integration` | Current main has no clipboard-image-to-temp-file terminal flow; reimplement against local backend/runtime seams if we take it. |

### Batch 4

| Commit    | Status  | Classification                    | Owner                 | Seam                    | Plan                                                                                                                                             |
| --------- | ------- | --------------------------------- | --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `246ef40` | landed  | `manual port`                     | `backend`             | `node / backend`        | Landed locally in the Phase 1 backend git port.                                                                                                  |
| `3134143` | defer   | `skip/defer`                      | `presentation`        | `Solid / UI`            | Label rename belongs with the deferred isolation-model family.                                                                                   |
| `0bc4d65` | partial | `manual port`                     | `presentation`        | `Solid / UI`            | The markdown-sanitization subset is a real current-main gap in `marked-shiki.ts`; other handler/theme pieces are already covered or lower value. |
| `c40a5f6` | covered | `reimplement on our architecture` | `backend`             | `node / backend`        | Local one-way diff backend already computes merge-base contexts.                                                                                 |
| `933931a` | bring   | `reimplement on our architecture` | `presentation`        | `runtime / integration` | Terminal links still open on plain click; bring the modifier-click safety fix through local terminal owners.                                     |
| `b51c0b7` | defer   | `skip/defer`                      | `handler / transport` | `runtime / integration` | Electron microphone/clipboard permission widening is not a current parity target for this fork.                                                  |
| `69b0a4b` | skipped | `skip/defer`                      | `presentation`        | `docs / sanity only`    | Dependency bump only.                                                                                                                            |
| `a37b958` | later   | `reimplement on our architecture` | `workflow / app`      | `runtime / integration` | Same `.md` file-viewer family as `9ce6abe`.                                                                                                      |
| `e56a9fc` | later   | `reimplement on our architecture` | `presentation`        | `Solid / UI`            | Local `PlanViewerDialog` is the right owner for Mermaid support; useful but not as urgent as the git correctness queue.                          |
| `7a9565b` | defer   | `skip/defer`                      | `handler / transport` | `runtime / integration` | Keep with the deferred Electron permission family.                                                                                               |
| `2f1d498` | skipped | `skip/defer`                      | `presentation`        | `docs / sanity only`    | Release tag only.                                                                                                                                |
| `b944064` | later   | `manual port`                     | `presentation`        | `Solid / UI`            | Added/deleted-file diff preview polish remains a clean local follow-up.                                                                          |
| `91f00f4` | skipped | `skip/defer`                      | `presentation`        | `docs / sanity only`    | Dependency bump only.                                                                                                                            |

## Recommended Next Actions

1. Phase 1 is now landed locally:
   - `c40d743`
   - `23ae2bb`
   - `246ef40`
   - `777f1d7`
   - `c42b921`
2. Take the markdown/link hardening slice next:
   - `0bc4d65` markdown-sanitization subset
   - `933931a`
3. Keep the larger redesign/defer families explicit:
   - isolation-model family: `8d30d7e`, `95d0f06`, `2b82e88`, `3134143`
   - terminal scroll/xterm family: `60857bd`, `e07d69d`, `0882952`
   - upstream Docker family: `0a31fb7`, `e96fba1`
4. Revisit the later UX/media queue after the markdown/link slice lands:
   - `88b5b8f`
   - `fb86cc5`
   - `a350209`
   - `9ce6abe`
   - `774ffe2`
   - `cec983b`
   - `a37b958`
   - `e56a9fc`
   - `b944064`
