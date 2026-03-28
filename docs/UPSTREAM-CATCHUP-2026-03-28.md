# Upstream Catch-up Review 2026-03-28

This document records the full per-commit review of the upstream-only range on `origin/main` that
is not present on local `main`.

Scope:

- upstream branch reviewed: `origin/main`
- upstream head at review time: `4792390`
- review date: `2026-03-28`
- local head at review time: `f81cd67`
- shared graph ancestor: `b250446`
- commits reviewed in range: `61` non-merge commits

Use this with [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md), which remains the high-level
parity ledger.

## Summary

- There are no new upstream commits beyond the already-reviewed head `4792390`.
- The review/diff/plan/sidebar/notification/project/task UI commits in this range are either
  already ported or intentionally skipped as non-parity visual/docs churn.
- The Docker isolation family is intentionally deferred. Upstream implemented it as a desktop-local
  Electron/container feature; this fork is web-first and still treats task isolation as
  worktree/backend-owned.
- Two broad cleanup commits remain explicitly partial:
  - `fe92c17`: non-Docker parity fixes are already covered locally; Docker-only pieces stay
    deferred
  - `2430b97`: only the already-ported prompt-send/channel-lifecycle/storage subset remains a
    parity target; the rest is intentionally skipped refactor churn

## Per-Commit Ledger

### Batch 1

| Commit    | Status  | Classification                    | Owner            | Seam                    | Plan                                                                                         |
| --------- | ------- | --------------------------------- | ---------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `cc3f9c7` | covered | `reimplement on our architecture` | `presentation`   | `Solid / UI`            | Already present in the local review-surface stack.                                           |
| `7dc1f4f` | covered | `reimplement on our architecture` | `workflow / app` | `Solid / UI`            | Already present in the ask-about-code/review-session flow.                                   |
| `34998db` | covered | `reimplement on our architecture` | `workflow / app` | `Solid / UI`            | Already covered by local review annotation/session owners.                                   |
| `c126a48` | covered | `manual port`                     | `workflow / app` | `Solid / UI`            | Follow-up review fixes are already reflected in the current review surfaces.                 |
| `9d3d79b` | covered | `manual port`                     | `workflow / app` | `Solid / UI`            | Ask-code truncation handling already exists locally.                                         |
| `a192f98` | covered | `manual port`                     | `backend`        | `node / backend`        | Binary diff exclusion is already in the backend diff path.                                   |
| `31b7606` | covered | `reimplement on our architecture` | `presentation`   | `Solid / UI`            | Plan review dialog already exists in the local plan/review surface stack.                    |
| `ee8cd61` | covered | `manual port`                     | `presentation`   | `Solid / UI`            | Merge commit list scrollability is already represented in the local merge dialog/list stack. |
| `ae858a6` | covered | `reimplement on our architecture` | `workflow / app` | `runtime / integration` | Push output streaming is already in the backend/workflow/dialog path.                        |
| `d3bca6e` | covered | `manual port`                     | `backend`        | `node / backend`        | Local plan watcher already watches both canonical plan roots.                                |
| `9902a31` | skipped | `skip/defer`                      | `presentation`   | `docs / sanity only`    | README/marketing copy only.                                                                  |
| `5c5766b` | covered | `reimplement on our architecture` | `presentation`   | `Solid / UI`            | Floating Review Plan affordance already exists locally.                                      |
| `bba36dd` | covered | `manual port`                     | `backend`        | `node / backend`        | Untracked pseudo-diff binary detection is already handled in the diff backend.               |
| `2278c82` | covered | `manual port`                     | `backend`        | `node / backend`        | Plan content restore from disk is already part of local persistence hydration.               |
| `588e34f` | covered | `manual port`                     | `backend`        | `node / backend`        | Exact `planFileName` persistence/restore already exists locally.                             |

### Batch 2

| Commit    | Status  | Classification                    | Owner                | Seam                    | Plan                                                                                             |
| --------- | ------- | --------------------------------- | -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `9ba275a` | covered | `manual port`                     | `backend`            | `node / backend`        | Path validation/logging/unexported plan helper behavior is already in local plan owners.         |
| `7505c3f` | covered | `manual port`                     | `presentation`       | `Solid / UI`            | Local floating plan button already uses opaque styling.                                          |
| `408dd9d` | covered | `manual port`                     | `presentation`       | `Solid / UI`            | Same plan-button path as above; no opacity parity gap remains.                                   |
| `30365c6` | covered | `manual port`                     | `presentation`       | `Solid / UI`            | Local sidebar already uses `ParallelCode` branding.                                              |
| `f745408` | covered | `manual port`                     | `backend`            | `node / backend`        | Local watcher startup already ignores pre-existing plans.                                        |
| `eb21feb` | covered | `reimplement on our architecture` | `presentation`       | `Solid / UI`            | Keyboard dialog navigation already exists in the shared dialog/review surfaces.                  |
| `524750c` | covered | `manual port`                     | `presentation`       | `Solid / UI`            | Paste-duplication prevention is already in the terminal shortcut/input path.                     |
| `9b31b20` | covered | `manual port`                     | `workflow / app`     | `docs / sanity only`    | Hook parity is already represented in local husky/CI scripts.                                    |
| `5d5570b` | skipped | `skip/defer`                      | `presentation`       | `docs / sanity only`    | Release tag only.                                                                                |
| `7ab191e` | skipped | `skip/defer`                      | `presentation`       | `docs / sanity only`    | Lint/cleanup only; no parity behavior.                                                           |
| `3588b20` | covered | `manual port`                     | `workflow / app`     | `docs / sanity only`    | Node heap increase is already in the local release workflow.                                     |
| `b483e65` | covered | `manual port`                     | `backend`            | `node / backend`        | Stale plan suppression in fresh sessions is already handled by local watcher startup.            |
| `4c0a250` | covered | `reimplement on our architecture` | `workflow / app`     | `runtime / integration` | Native/browser task notifications already exist through the local runtime/capability/sink split. |
| `21c2105` | skipped | `skip/defer`                      | `presentation`       | `Solid / UI`            | Accent-tint visual polish is not a parity target.                                                |
| `d245dce` | covered | `manual port`                     | `store / projection` | `Solid / UI`            | Shell toolbar Alt+Arrow navigation is already in the local focus + shell-section owners.         |

### Batch 3

| Commit    | Status   | Classification                    | Owner                | Seam                    | Plan                                                                                                                                          |
| --------- | -------- | --------------------------------- | -------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `a75d0b3` | skipped  | `skip/defer`                      | `presentation`       | `docs / sanity only`    | Release tag only.                                                                                                                             |
| `65051a9` | skipped  | `skip/defer`                      | `presentation`       | `docs / sanity only`    | Formatting only.                                                                                                                              |
| `92836f7` | covered  | `reimplement on our architecture` | `store / projection` | `Solid / UI`            | Grouped collapsed tasks are already handled by the local sidebar projection owner.                                                            |
| `cb511e5` | skipped  | `skip/defer`                      | `presentation`       | `Solid / UI`            | Theme lightness tweak is intentionally deferred.                                                                                              |
| `eb8ec58` | covered  | `manual port`                     | `presentation`       | `Solid / UI`            | Project-delete confirmation already exists in the sidebar flow.                                                                               |
| `5ff0add` | covered  | `reimplement on our architecture` | `workflow / app`     | `Solid / UI`            | Review comment editing already exists in the local review-session stack.                                                                      |
| `e326596` | skipped  | `skip/defer`                      | `presentation`       | `docs / sanity only`    | Release tag only.                                                                                                                             |
| `b4b87b5` | covered  | `manual port`                     | `presentation`       | `Solid / UI`            | Stronger keyboard focus outlines are already in local styles.                                                                                 |
| `471ed09` | covered  | `cherry-pick directly`            | `workflow / app`     | `docs / sanity only`    | Ignore-rule update is already present locally.                                                                                                |
| `45f4633` | covered  | `cherry-pick directly`            | `backend`            | `node / backend`        | Stale `origin/HEAD` handling is already in the local git backend.                                                                             |
| `f3abdb5` | skipped  | `skip/defer`                      | `presentation`       | `Solid / UI`            | Placeholder-subtlety polish is not a parity target.                                                                                           |
| `efdd90f` | skipped  | `skip/defer`                      | `presentation`       | `docs / sanity only`    | Docs-only.                                                                                                                                    |
| `52c3be8` | skipped  | `skip/defer`                      | `presentation`       | `docs / sanity only`    | Docs-only.                                                                                                                                    |
| `a737bc3` | covered  | `reimplement on our architecture` | `workflow / app`     | `runtime / integration` | Notification preference/click hardening is already in the local notification runtime.                                                         |
| `c646df4` | deferred | `skip/defer`                      | `backend`            | `docs / sanity only`    | Docker isolation is intentionally deferred. If pursued later, reimplement it as a backend-owned runner capability for the web/server runtime. |

### Batch 4

| Commit    | Status   | Classification                    | Owner                 | Seam                    | Plan                                                                                                                                                                                    |
| --------- | -------- | --------------------------------- | --------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2be2c00` | deferred | `skip/defer`                      | `backend`             | `docs / sanity only`    | Docker lifecycle/env forwarding/UX follow-up stays deferred with the Docker family.                                                                                                     |
| `064a4ea` | deferred | `skip/defer`                      | `backend`             | `docs / sanity only`    | Bundled Dockerfile/image build support stays deferred with the Docker family.                                                                                                           |
| `c456632` | deferred | `skip/defer`                      | `backend`             | `docs / sanity only`    | Docker review-finding follow-up stays deferred with the Docker family.                                                                                                                  |
| `4bb68ae` | skipped  | `skip/defer`                      | `backend`             | `docs / sanity only`    | Docker-adjacent lint cleanup only.                                                                                                                                                      |
| `fe92c17` | partial  | `reimplement on our architecture` | `backend`             | `runtime / integration` | Non-Docker parity pieces are already covered locally: validation, branch uniqueness, plan watcher cleanup, and notification hardening. Docker-only pieces stay deferred.                |
| `38a6ea3` | covered  | `manual port`                     | `presentation`        | `Solid / UI`            | Leading/trailing context gaps are already in the local scrolling diff view.                                                                                                             |
| `3393f34` | covered  | `reimplement on our architecture` | `handler / transport` | `node / backend`        | Notification IPC hardening is already in the local handler/runtime split.                                                                                                               |
| `53a6deb` | covered  | `reimplement on our architecture` | `backend`             | `node / backend`        | Lock-free changed-file enumeration is already represented by the local diff backend.                                                                                                    |
| `0c31c9b` | covered  | `reimplement on our architecture` | `backend`             | `node / backend`        | Buffer caps and watcher cleanup already live in the backend task/git owners.                                                                                                            |
| `4959b29` | covered  | `reimplement on our architecture` | `workflow / app`      | `runtime / integration` | Non-git project rejection already exists in the local project workflow.                                                                                                                 |
| `7b3580c` | covered  | `manual port`                     | `presentation`        | `Solid / UI`            | Selected-file auto-scroll is already in the local changed-files list.                                                                                                                   |
| `98ebef8` | covered  | `manual port`                     | `presentation`        | `Solid / UI`            | Open-in-editor click target narrowing is already in the local branch-info bar.                                                                                                          |
| `0b1850b` | covered  | `manual port`                     | `presentation`        | `Solid / UI`            | QR CJS default-export handling is already in the local remote-connect modal.                                                                                                            |
| `99189ec` | covered  | `manual port`                     | `presentation`        | `Solid / UI`            | Direct-mode checkbox race is already fixed in the local new-task dialog.                                                                                                                |
| `2430b97` | partial  | `skip/defer`                      | `workflow / app`      | `docs / sanity only`    | Only the small already-ported subset remains a parity target: storage durability, prompt-send cleanup, and explicit channel disposal. The rest is intentionally skipped refactor churn. |
| `b9dc240` | skipped  | `skip/defer`                      | `presentation`        | `docs / sanity only`    | Formatting only.                                                                                                                                                                        |
| `c190073` | covered  | `manual port`                     | `store / projection`  | `Solid / UI`            | Focus retention after keyboard reorder already exists in local navigation.                                                                                                              |
| `4792390` | covered  | `manual port`                     | `presentation`        | `docs / sanity only`    | `build/icon.icns` matches upstream head exactly; no action remains.                                                                                                                     |

## Recommended Next Actions

1. Keep the Docker isolation family explicitly deferred unless the product direction changes.
   If revived, treat it as `reimplement on our architecture` and design it for the web/server
   runtime first.
2. Do not reopen the already-ported review/diff/plan/notification/sidebar commits unless a current
   regression points back to them.
3. If upstream moves again, start from `4792390..origin/main`, not from the shared ancestor, and
   append the new review to this ledger.
