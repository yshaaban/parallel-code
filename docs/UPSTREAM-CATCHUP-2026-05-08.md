# Upstream Catch-up Review 2026-05-08

This document records the intake review for the upstream range that landed after the
`2026-04-17` catch-up pass.

Scope:

- upstream branch reviewed: `origin/main`
- upstream head at review time: `7aaf640`
- previous reviewed upstream head: `a0f5280`
- review date: `2026-05-08`
- shared graph ancestor with upstream: `b250446`
- commits reviewed in range: `121`

Use this with [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md). This fork is intentionally
selective: port behavior and tests into the local owner, not upstream file shape.

## Disposition Key

- `adopt-rewrite`: useful behavior that should be implemented in local architecture owners
- `adopt-verify`: likely already covered or close to covered, but needs evidence before closing
- `redesign`: useful product direction, but the upstream implementation conflicts with local
  browser-first ownership or needs a larger local design
- `inspire`: presentation or ergonomics signal that can guide future local polish, with no parity
  requirement
- `skip`: release, marketing, docs-only, merge-shape, or upstream-specific change that should not
  be ported

## Summary

Do not merge or rebase `origin/main` directly. The upstream range changes broad Electron IPC,
large UI components, OpenSpec docs, themes, and release assets in ways that would overwrite local
browser/server ownership, task-container work, preview exposure, remote testing support, and
high-performance terminal/session architecture.

The useful queue was reviewed as:

1. Git, diff, merge, and changed-files correctness.
2. Shell/runtime hardening and swallowed-error visibility.
3. Shortcut/keybinding behavior integrated with local shortcut owners, including browser-first
   persisted overrides and settings UI.
4. Terminal image drag/drop and copy cleanup, on top of the existing local clipboard-image seam.
5. Dialog accessibility and inline-input cancellation.
6. Existing-worktree import, PR check watching, coverage, commit-history navigation, and MiniMax
   Ask Code support landed through backend-owned local redesigns.
7. Optional product decisions: non-git projects, Docker runner profile inspiration, and theme
   variants are not direct-port candidates in this pass.
8. Follow-up task-switch shortcut behavior landed through local keybinding/focus owners; the
   follow-up preload allowlist fix does not map because that IPC channel is not present locally.

## Commit Ledger

| Commit                                                    | Disposition   | Local action                                                                                                                                        |
| --------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b36a9e0` style steps row layout                          | inspire       | Review only as task-steps presentation polish; local task-steps owners already differ.                                                              |
| `d0156f9` sandbox `.claude` placeholder                   | skip          | Upstream bwrap placeholder handling does not map to local task-container architecture.                                                              |
| `346c7d0` pty backfills `.claude` placeholders            | skip          | Same sandbox-specific placeholder family; avoid moving durable worktree policy into PTY spawn.                                                      |
| `2a0c1e0` replace symlinked `.claude` settings            | skip          | Sandbox compatibility detail, not local browser-first task-container truth.                                                                         |
| `0959901` seed `.claude` per worktree                     | skip          | Do not port upstream worktree seeding policy unless local task setup needs it explicitly.                                                           |
| `3c61dcd` scope step jump to live session                 | adopt-verify  | Verified local task-step jump is task-scoped through `jumpToTaskStepTarget(taskId, step)`.                                                          |
| `4e832d1` exclude sandbox placeholders from changed files | skip          | Placeholder-only diff filtering should not enter local git owners unless local placeholders exist.                                                  |
| `819c39c` align steps history rows                        | inspire       | Presentation-only task-steps polish.                                                                                                                |
| `ec7a504` inherit full login shell env                    | adopt-rewrite | Landed via `electron/user-shell.ts` and Electron startup shell adaptation.                                                                          |
| `0942965` project-specific Dockerfiles                    | redesign      | Use only as inspiration for future task-container runner profiles.                                                                                  |
| `d5cd545` hide jump button until terminal ready           | adopt-verify  | Verified local task-steps jump is safe without a ready terminal: it focuses the AI terminal, first shell, or prompt through `jumpToTaskStepTarget`. |
| `16bc331` MiniMax Ask Code provider                       | adopt-rewrite | Landed through backend Ask Code provider routing with env-owned command/config and abort-safe streaming.                                            |
| `88e88e3` existing worktree import                        | adopt-rewrite | Landed as backend-owned task registration with git/review/convergence/steps watchers and external-worktree ownership guards.                        |
| `8bdb7f8` focus mode                                      | inspire       | Local focus/workbench layout already diverged; inspect for missing keyboard/visibility semantics.                                                   |
| `d587a48` exclude `steps.json` from `.claude` seed        | skip          | Tied to skipped sandbox seeding family.                                                                                                             |
| `5330889` configurable keybinding system                  | adopt-rewrite | Landed through a shared command registry, persisted overrides, settings UI, conflict warnings, and local shortcut dispatch.                         |
| `4632854` OpenSpec seed                                   | skip          | Upstream docs process artifact; local docs own architecture.                                                                                        |
| `f7c062a` send notes to agent as prompt                   | adopt-rewrite | Landed through `TaskNotesFilesSection` using the existing app-owned `sendPrompt` workflow.                                                          |
| `9766235` PR CI checks                                    | adopt-rewrite | Landed as backend-owned task review signals with typed bootstrap/live events; renderer only projects the signal banner.                             |
| `ad79f31` two-column focus mode                           | inspire       | Presentation/layout signal only; protect terminal responsiveness and local TaskPanel owners.                                                        |
| `c171c18` folders without git                             | redesign      | Requires explicit non-git project mode; do not mix into git/worktree task assumptions.                                                              |
| `4ee32ed` step text size                                  | inspire       | Local typography tokens should decide.                                                                                                              |
| `bd45979` titlebar task indicators                        | inspire       | Compare with local supervision/attention projections before adopting.                                                                               |
| `0a8f433` keep add-task agent row inline                  | inspire       | Presentation-only.                                                                                                                                  |
| `5ebd34d` focus mode shortcut                             | inspire       | Focus-mode UI is not a current local product surface; revisit only if local workbench focus mode is designed.                                       |
| `05a2553` split task naming for git/titlebar              | adopt-verify  | Verified local `clean-task-name`, backend branch slugging, and persisted `Task.name` keep UI names separate from git names.                         |
| `0c5de26` persist auto task-name state                    | adopt-verify  | Verified current task names persist in `persistence-codecs`/load paths; no separate upstream auto-name state exists locally.                        |
| `8642fda` simplify focus navigation                       | inspire       | Local focus/navigation owners should be reviewed for equivalent ergonomics only.                                                                    |
| `2ca8db2` release 1.6.0                                   | skip          | Upstream release metadata.                                                                                                                          |
| `43ebf73` focus-mode panel highlight                      | inspire       | Presentation-only unless local focus state regressed.                                                                                               |
| `6638855` ignore alt-arrow in changed files nav           | adopt-rewrite | Landed in `ChangedFilesList` so Alt+Arrow remains app-level navigation.                                                                             |
| `e4604b1` bump `@xmldom/xmldom`                           | adopt-verify  | Covered by local `@xmldom/xmldom@0.8.11` transitive dependency.                                                                                     |
| `1f0c090` AI terminal font size                           | inspire       | Local terminal typography settings already own this.                                                                                                |
| `51eb740` coverage radar                                  | adopt-rewrite | Landed as backend-owned coverage artifact parsing in task review signals with replayable browser bootstrap.                                         |
| `c20de32` untracked file handling                         | adopt-rewrite | Landed in local `git-diff-ops`/status owners with pseudo-diff fixture coverage.                                                                     |
| `2cf3628` terminal scrollback keybindings                 | adopt-rewrite | Landed through `src/lib/terminal-shortcuts.ts` and the terminal-session shortcut owner.                                                             |
| `aa6f633` shell toolbar padding                           | inspire       | Presentation-only.                                                                                                                                  |
| `50e24db` resolve diff base to `origin/<branch>`          | adopt-rewrite | Landed in the stronger local diff-base picker that chooses the closest local-or-origin merge-base.                                                  |
| `d18e9b1` flex-first resizable panel                      | inspire       | Avoid broad upstream panel refactor; preserve local terminal performance constraints.                                                               |
| `f8d4953` panel review cleanups                           | inspire       | Presentation/refactor only.                                                                                                                         |
| `bf23c08` cap steps height and shell default              | inspire       | Local TaskPanel sizing/performance owners decide.                                                                                                   |
| `3710c80` drop shell pin when last terminal closes        | adopt-verify  | Verified local shell layout is owned by `TaskShellSection` and task shell IDs; stale shell reservations are not persisted state.                    |
| `09b7f7a` show target base branch in merge dialog         | adopt-rewrite | Landed with task `baseBranch` propagation through merge status, rebase, review, and convergence owners.                                             |
| `460b9c4` pick diff base by closest merge-base            | adopt-rewrite | Landed in `electron/ipc/git-diff-ops.ts` with local-main-ahead and origin-main-ahead fixtures.                                                      |
| `695efcd` shell-section min-height in split mode          | inspire       | Presentation-only.                                                                                                                                  |
| `60c52e9` release 1.7.0                                   | skip          | Upstream release metadata.                                                                                                                          |
| `5620e38` bump `postcss`                                  | adopt-verify  | Covered by local `postcss@8.5.6` transitive dependency.                                                                                             |
| `f503521` split right column default                      | inspire       | Presentation-only.                                                                                                                                  |
| `0870e53` panel JSDoc                                     | skip          | Upstream component documentation only.                                                                                                              |
| `db8cfe4` sidebar list caps/toggles                       | inspire       | Local sidebar state already has browser-session persistence owners.                                                                                 |
| `78a94b0` hoist sidebar constants                         | inspire       | Upstream refactor only.                                                                                                                             |
| `5807b25` Islands Dark theme                              | inspire       | Theme inspiration only; local design tokens and contrast rules win.                                                                                 |
| `1132016` Islands Dark separation                         | inspire       | Theme polish only.                                                                                                                                  |
| `726c42d` Minimal palette hierarchy                       | inspire       | Theme polish only.                                                                                                                                  |
| `3ad227d` restore prompt focus outline                    | adopt-verify  | Verified shared dialog/panel focus-visible styling in `src/styles.css` covers the restored focus-outline behavior.                                  |
| `4a06446` OpenSpec snapshot                               | skip          | Upstream docs artifact.                                                                                                                             |
| `64f9bc6` OpenSpec review fixes                           | skip          | Upstream docs artifact.                                                                                                                             |
| `3f0b473` renderer/main loggers                           | adopt-rewrite | Landed through bounded main/renderer loggers and typed renderer-to-main forwarding.                                                                 |
| `81185b4` tracing and silent-swallow sweep                | adopt-rewrite | Landed as targeted silent-swallow visibility across local runtime, shell, store, and UI owners.                                                     |
| `b868098` logger tests                                    | adopt-rewrite | Landed with local logger and handler tests.                                                                                                         |
| `f78a9d9` dialog accessibility                            | adopt-rewrite | Landed through local `Dialog` stack, aria labels, modal ownership, and Escape handling.                                                             |
| `e290cff` logging review fixes                            | adopt-rewrite | Landed in local logging validation/rate-limit behavior.                                                                                             |
| `9afd604` logging follow-up fixes                         | adopt-rewrite | Landed in local malformed-payload and forwarding hardening.                                                                                         |
| `8044368` simplify logging rate-cap                       | adopt-rewrite | Landed through per-category renderer forwarding rate caps.                                                                                          |
| `71c02c1` notes panel max-height                          | inspire       | Presentation-only.                                                                                                                                  |
| `3336695` close gap above AI terminal                     | inspire       | Presentation-only; preserve local TaskPanel layout owners.                                                                                          |
| `b6a4af0` Islands Dark hairlines                          | inspire       | Theme polish only.                                                                                                                                  |
| `58f4417` tiling scroll affordance                        | inspire       | Presentation-only.                                                                                                                                  |
| `5501615` drop scroll affordance pulse                    | inspire       | Presentation-only.                                                                                                                                  |
| `3d573b0` Workbench theme                                 | inspire       | Theme inspiration only.                                                                                                                             |
| `19a3648` Workbench gaps/separator                        | inspire       | Theme polish only.                                                                                                                                  |
| `a80d058` Workbench column border                         | inspire       | Theme polish only.                                                                                                                                  |
| `a1d2c16` dedupe branch-row border                        | inspire       | Theme refactor only.                                                                                                                                |
| `eb3b18d` xterm scrollbars                                | inspire       | Presentation-only; test terminal contrast if adopted.                                                                                               |
| `ff98743` cap steps panel auto growth                     | adopt-verify  | Verified `TaskStepsSection` reports natural height capped at 260px with a 72px floor.                                                               |
| `fb14e0a` add spec                                        | skip          | Upstream docs/spec artifact.                                                                                                                        |
| `e0bbbe5` polish Islands Dark                             | inspire       | Theme polish only.                                                                                                                                  |
| `8248a5e` mac local install                               | skip          | Upstream POSIX-only frontend build memory flag is not ported into cross-platform npm scripts; revisit only if local build proves memory-bound.      |
| `affe319` Ctrl+0 zoom reset                               | adopt-verify  | Verified `src/runtime/app-shortcuts.ts` registers global Cmd/Ctrl+0 and `app-shortcuts.test.ts` covers it.                                          |
| `2223552` scroll steps to bottom                          | redesign      | Deferred for task-steps polish; current local section caps height and keeps keyboard scrolling explicit to protect terminal layout stability.       |
| `4565a40` rounded panel clip                              | inspire       | Theme polish only.                                                                                                                                  |
| `bfdde76` new screens                                     | skip          | Upstream marketing assets.                                                                                                                          |
| `410cf06` README screenshots                              | skip          | Upstream marketing docs.                                                                                                                            |
| `d80262f` release 1.8.0                                   | skip          | Upstream release metadata.                                                                                                                          |
| `944687f` terminal paste/drop images                      | adopt-rewrite | Landed through terminal-session paste/drop owners, typed IPC, preload file-path resolution, and dropped-image save handling.                        |
| `8965994` new screens                                     | skip          | Upstream marketing assets.                                                                                                                          |
| `e462c0b` focus border with sidebar focus                 | inspire       | Presentation-only unless local focus ring conflicts.                                                                                                |
| `9fd91e0` README feature refresh                          | skip          | Upstream marketing docs.                                                                                                                            |
| `0fe906b` README tagline                                  | skip          | Upstream marketing docs.                                                                                                                            |
| `a096896` focus border on toolbar click                   | inspire       | Presentation-only.                                                                                                                                  |
| `04c9395` terminal copy reflow                            | adopt-rewrite | Landed through `src/lib/copy-text.ts` and terminal-session copy handling.                                                                           |
| `1d7ac3a` new-task pinned footer                          | inspire       | Presentation-only unless local dialog usability needs it.                                                                                           |
| `7492848` mod-shift-click project root in editor          | adopt-rewrite | Landed in `TaskBranchInfoBar` through existing editor/system helpers.                                                                               |
| `262a507` open-in-editor for viewers                      | adopt-rewrite | Landed in `PlanViewerDialog` with Electron-only editor affordance and browser fallback.                                                             |
| `5e9d396` one-way changed-file diffs                      | adopt-rewrite | Covered by local diff-base single-start ranges and branch/file diff tests.                                                                          |
| `7887e2c` drop rebased patch-equivalents                  | adopt-rewrite | Landed through cherry-pick refinement in local backend diff owners.                                                                                 |
| `96d61b5` collapse fully merged branches                  | adopt-rewrite | Landed; fully patch-equivalent branches now collapse to an empty diff range.                                                                        |
| `82a4826` uncommitted-only navigation                     | redesign      | Deferred with changed-files navigation redesign; current local review surface is per-file plus review-panel owned, not upstream commit-nav shape.   |
| `8e7cf02` patch-equivalent main-ahead count               | adopt-rewrite | Landed through backend merge status using cherry-pick-aware right-only counts.                                                                      |
| `128dadf` include merges in main-ahead count              | adopt-rewrite | Landed by using the final upstream count form without `--no-merges`.                                                                                |
| `ba23c24` fetch changed files on inactive mount           | adopt-rewrite | Covered by backend task-review snapshots and base-branch-aware saved-state restore.                                                                 |
| `4f27d9d` full-size file changes dialog                   | inspire       | Presentation-only; local review surface density decides.                                                                                            |
| `8b03a24` swallow stdio EPIPE                             | adopt-rewrite | Landed for both Electron and browser-server entry points through `electron/stdio.ts`.                                                               |
| `588dff7` diff viewer sidebar                             | adopt-rewrite | Landed by embedding `ChangedFilesList` while keeping per-file diffs behind `fetchTaskFileDiff`; task-owned snapshots are used when available.       |
| `45137b1` mac diff header drag overlap                    | adopt-verify  | Verified local diff viewer uses shared `Dialog` chrome with in-dialog controls, not upstream draggable-header overlay.                              |
| `8fd7f17` Linux diff top inset                            | adopt-verify  | Verified local diff viewer uses shared `Dialog` sizing/inset behavior rather than upstream platform-specific top inset.                             |
| `fb0c17b` Codex arguments                                 | adopt-verify  | Verified Codex args are normalized through `agent-catalog`, `agents.ts`, and persistence-agent-default owners.                                      |
| `d9f596b` plain rebase when no conflicts                  | adopt-rewrite | Landed as MergeDialog primary-action selection: plain rebase is primary only when no conflicts are detected.                                        |
| `67f3c5c` Docker agent auth sharing                       | redesign      | Use as task-container auth inspiration only; do not port upstream Docker wiring directly.                                                           |
| `cbdc770` commit history navigation direct mode           | adopt-rewrite | Landed through backend commit-history summaries and commit-scoped review file/diff targets in the local review surface.                             |
| `1601465` shortcut label copy                             | adopt-rewrite | Landed through clearer local HelpDialog shortcut labels.                                                                                            |
| `b626f6a` Islands Light theme                             | inspire       | Theme inspiration only.                                                                                                                             |
| `4ad340d` resolve HEAD before caching diff base           | adopt-rewrite | Covered by pinned head/branch cache keys plus task `baseBranch` in backend metadata.                                                                |
| `ba6da2c` Catppuccin Mocha theme                          | inspire       | Theme inspiration only.                                                                                                                             |
| `9932aa4` Cmd+1-9 task jump                               | adopt-rewrite | Landed through local shortcut policy and `jumpToTask` task-order projection.                                                                        |
| `77a05b2` bump `ip-address`                               | adopt-verify  | Covered by local `ip-address@10.1.0` transitive dependency.                                                                                         |
| `a35c05a` bump `axios`                                    | adopt-verify  | Covered by local `axios@1.13.5` transitive dependency.                                                                                              |
| `af685eb` inline-input cancel and Esc                     | adopt-rewrite | Landed in `InlineInput` with explicit Cancel affordance and scoped Escape handling.                                                                 |
| `04d2db1` task switch shortcut preserving panel focus     | adopt-rewrite | Landed through local keybinding, app-shortcut, and focus-navigation owners instead of upstream file shape.                                          |
| `08969d3` preload allowlist uncommitted diffs             | skip          | Not applicable: current local IPC has no `get_uncommitted_file_diffs` channel; enum/allowlist drift is already tested.                              |
| `7aaf640` duplicate preload allowlist PR closure          | skip          | Signed no-content upstream closure for `08969d3`; no separate local behavior to port.                                                               |

## Implementation Queue

### Closure Status

The `a0f5280..7aaf640` upstream range is closed as selective catch-up work.

- current upstream head after fetch: `7aaf640`
- unreviewed upstream commits after that head: `0`
- direct-port families from this range are implemented or verified in local owners
- graph divergence from `origin/main` remains expected because this fork ports behavior instead of
  merging upstream history

The items that remain from this document are future product decisions, not missed upstream ports.
They should be prioritized through product planning before implementation because each changes the
local product surface, durable state model, runner boundary, or non-git project assumptions.

### Current Local Progress

- `e4604b1`, `5620e38`, `77a05b2`, and `a35c05a` are covered by the current local lockfile:
  `@xmldom/xmldom@0.8.11`, `postcss@8.5.6`, `ip-address@10.1.0`, and `axios@1.13.5`.
  Verified with `npm ls axios ip-address @xmldom/xmldom postcss --depth=99`.
- `ec7a504` is landed locally through `electron/user-shell.ts` and `electron/main.ts`.
  Electron startup now imports the full login-shell environment, keeps runtime-altering variables
  protected, and preserves the browser/server architecture by keeping this as Electron shell
  adaptation. Verified with `npm run test:node:file -- electron/user-shell.test.ts`.
- `8b03a24` is landed locally through `electron/stdio.ts`, `electron/main.ts`, and
  `server/main.ts`. Both Electron and browser-server shells now swallow routine stdio `EPIPE`
  errors while rethrowing other stream errors. Verified with
  `npm run test:node:file -- electron/stdio.test.ts`.
- `50e24db`, `460b9c4`, `5e9d396`, `7887e2c`, and `96d61b5` are landed in
  `electron/ipc/git-diff-ops.ts`. The local backend diff owner now chooses the closest local or
  remote main merge-base, uses one-way diff ranges, drops contiguous patch-equivalent prefix
  commits, and collapses fully patch-equivalent branches to an empty range. Verified with
  `npm run test:node:file -- electron/ipc/git-diff-ops.test.ts`.
- `09b7f7a`, `8e7cf02`, `128dadf`, `4ad340d`, and `ba23c24` are landed across backend git,
  review, convergence, and task workflow owners. Task `baseBranch` now flows through merge status,
  rebase, branch logs, worktree status, task-review snapshots, convergence snapshots, and review
  diff/file requests, while main-ahead counts use `git rev-list --count --cherry-pick --right-only
HEAD...<base>`. Verified with targeted backend, app, and Solid tests for git mutation,
  git-status workflows, task handlers, task workflows, task review/convergence, review files/diffs,
  task git status, merge dialog, changed files, review panel, and diff viewer.
- `2cf3628` and `04c9395` are landed in terminal-local owners. Terminal scrollback shortcuts now
  stay local to xterm instead of reaching the PTY, and terminal copy uses a deterministic cleanup
  pipeline for padded/wrapped selections. Verified with
  `npm run test:node:file -- src/lib/copy-text.test.ts src/lib/terminal-shortcuts.test.ts` and
  `npm run test:solid:file -- src/components/terminal-view/terminal-session.test.tsx`.
- Browser terminal validation also hardened the shared input path. Keyboard trace starts now match
  the terminal data they produced and stale unmatched starts are discarded, so non-emitting control
  shortcuts cannot contaminate the next input-latency sample. Interactive browser input now drains
  with the same bounded in-flight cap as the general input path, keeping rapid foreground typing
  responsive without coalescing user-visible characters. The rapid browser-input test now waits for
  the full 12-character burst before asserting tail latency. Verified with
  `npm run test:node:file -- src/components/terminal-view/terminal-input-pipeline.test.ts`,
  `npm run test:browser:file -- tests/browser/terminal-input.spec.ts --project chromium --workers=1`,
  and `npm run test:browser:canaries`.
- `944687f` is landed through the terminal-session clipboard/drop owner, typed IPC channels
  (`ResolveClipboardPaste`, `SaveDroppedImage`), preload file-path resolution, native dropped-image
  persistence, path escaping, and browser-mode no-op fallback for local file access. Verified with
  `npm run test:node:file -- src/lib/terminal-drop.test.ts electron/ipc/system-handlers.test.ts
electron/ipc/preload-allowlist.test.ts` and terminal-session Solid tests.
- `3f0b473`, `81185b4`, `b868098`, `e290cff`, `9afd604`, and `8044368` are landed through local
  bounded loggers, renderer-to-main forwarding, malformed-payload validation, rate caps, and
  targeted silent-swallow visibility. Verified with `electron/log.test.ts`,
  `src/lib/log.test.ts`, `electron/ipc/system-handlers.test.ts`, and persistence/client-session
  tests for the verbose-logging setting.
- `f78a9d9` and `af685eb` are landed through `Dialog`, `DialogHeader`, dialog stack state,
  dialog focus-visible styling, and `InlineInput`. Dialogs now expose labels/descriptions,
  topmost-only modal Escape handling, and inline inputs have explicit Cancel/Escape affordances.
  Verified with focused Dialog, InlineInput, and affected dialog tests.
- `04d2db1` is landed through local keybinding definitions, app-shortcut registration, and
  focus-navigation state. Direct task switching now preserves the focused panel when the target
  task exposes that panel, falls back to the target default panel otherwise, and stays inert while a
  blocking dialog owns focus. Verified with
  `npm run test:node:file -- src/store/focus.test.ts src/runtime/app-shortcuts.test.ts src/domain/keybindings.test.ts electron/ipc/preload-allowlist.test.ts`.
- `08969d3` and `7aaf640` are intentionally not ported because the current local IPC enum does not
  include `get_uncommitted_file_diffs`. The relevant safety property is preload allowlist drift,
  verified by `electron/ipc/preload-allowlist.test.ts`.
- `6638855`, `588dff7`, `d9f596b`, `f7c062a`, `1601465`, and `9932aa4` are landed in local
  presentation/workflow owners. Changed files ignore Alt+Arrow, DiffViewer embeds the changed-file
  list while retaining per-file backend diff fetches, MergeDialog makes plain rebase primary when
  there are no conflicts, task notes send through the app-owned prompt workflow, shortcut labels are
  clearer, and Cmd/Ctrl+1-9 task jump is registered in local shortcut policy. Verified with
  ChangedFilesList, DiffViewerDialog, MergeDialog, TaskNotesFilesSection, HelpDialog,
  `src/lib/shortcuts.test.ts`, and `src/runtime/app-shortcuts.test.ts`.
- `7492848` and `262a507` are landed through existing editor/system helpers in
  `TaskBranchInfoBar` and `PlanViewerDialog`, with browser-mode editor affordances suppressed.
  Verified with their focused Solid tests.
- `16bc331`, `88e88e3`, `5330889`, `9766235`, `51eb740`, and `cbdc770` are landed through local
  redesigns rather than upstream file shape: backend-owned existing-worktree import, configurable
  browser-first keybindings, MiniMax Ask Code provider routing, replayable PR CI/coverage review
  signals, and commit-scoped review navigation. Verified with focused backend, app, persistence,
  shortcut, and review-panel tests.
- `3c61dcd`, `d5cd545`, `05a2553`, `0c5de26`, `3710c80`, `3ad227d`, `ff98743`, `8248a5e`,
  `affe319`, `45137b1`, `8fd7f17`, and `fb0c17b` were verification rows. Current local owners
  either already cover them or intentionally diverge: task-step jump falls back to prompt when no
  terminal exists; task names persist separately from branch/worktree slugs; task shell layout is
  owned by `TaskShellSection`; prompt/dialog focus rings are covered by shared CSS; steps height is
  capped at 260px; zoom reset is globally registered; diff dialog chrome uses the shared Dialog
  header/body structure; and agent arguments are normalized through `agent-catalog` and
  persistence-agent-default owners.
- Final broad validation for this catch-up pass: `npm run typecheck`, `npm run test:node`,
  `npm run test:solid`, `npm run test:browser:file -- tests/browser/terminal-input.spec.ts
--project chromium --workers=1`, `npm run test:browser:canaries`, and `git diff --check`.

### Phase 1: Safety and Diagnostics

- Verify dependency/security bumps against local `package.json` and `package-lock.json`.
- Port shell environment inheritance and EPIPE shutdown hardening where local runtime owners need it.
- Design local logging/diagnostics improvements around `runtime-diagnostics`, not upstream
  `electron/log.ts` file shape.

Validation:

- targeted node tests for user shell, process/logging edge cases, and diagnostics
- `npm run typecheck`

### Phase 2: Git, Merge, and Changed Files

- Recreate upstream diff-base and patch-equivalence semantics in local backend git owners.
- Add fixtures for remote branch base selection, closest merge-base, one-way diffs, rebased
  patch-equivalents, fully merged branches, stale HEAD cache invalidation, inactive-task refresh,
  and plain rebase when no conflicts exist.

Validation:

- targeted `electron/ipc/git-*` tests
- changed-files Solid tests for any UI navigation changes
- full `npm run test:node` after targeted green

### Phase 3: Shortcut and Terminal Ergonomics

- Route user-configurable keybindings through browser-first persistence, command ids, conflict
  detection, and local shortcut dispatch.
- Port terminal scrollback shortcuts, task jump shortcuts, image drag/drop, and copy reflow without
  compromising terminal input latency or browser fallback behavior.

Validation:

- `src/lib/terminal-shortcuts.ts` tests
- terminal-session Solid tests
- browser terminal matrix if runtime behavior changes

### Phase 4: Accessibility and Review UX

- Port dialog accessibility, inline-input cancel, and diff-sidebar behavior through local dialog,
  inline input, and review-surface owners.

Validation:

- focused Solid tests for keyboard, focus, and screen-reader state
- review-surface architecture tests where ownership could drift

### Phase 5: Larger Product Redesigns

- Existing-worktree import is implemented as a backend-owned redesign; upstream's renderer-owned
  imported-task flag is intentionally not used.
- PR CI status and coverage are handled through backend-owned task review signals with replayable
  state and browser bootstrap.
- MiniMax Ask Code support is implemented through backend provider routing and env-owned provider
  config.
- Commit-history review navigation is implemented through backend commit summaries and
  commit-scoped review diff targets.
- Non-git projects and task-container runner-profile ideas remain explicit future product
  decisions; no direct upstream file-shape port in this pass.

Validation:

- backend state tests first
- browser replay/reconnect tests for pushed state
- UI tests only after backend truth and projection are proven

## Implemented Local Redesigns

These upstream ideas are closed for this catch-up range through local architecture owners rather
than direct upstream file shape.

| Item                                    | Local owner shape                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing-worktree import                | Backend validates and registers imported worktrees, starts git/review/convergence/task-step watchers, and keeps external worktrees out of delete/merge cleanup. |
| PR CI status watcher                    | Backend loads GitHub PR status/check runs on demand and exposes sequenced, replayable task review signals; renderer only projects badges.                       |
| Configurable keybindings                | Shared shortcut registry owns command ids/defaults/conflicts, store/persistence owns overrides, and settings UI exposes record/disable/reset/conflict feedback. |
| Changed-files commit-history navigation | Backend commit-history owner exposes summaries; `ReviewPanel` renders commit selection and uses commit-scoped file/diff targets.                                |
| Coverage radar                          | Backend parses common coverage artifacts and projects summaries into task review signals.                                                                       |
| MiniMax Ask Code provider               | Backend Ask Code provider routing owns env-based command/config and abort-safe streaming.                                                                       |

## Future Product Redesign Queue

These items are intentionally not part of the upstream parity queue. Each should ship only after a
local design that preserves browser-first runtime behavior, backend authority, preview exposure,
remote testing, reconnect/replay, and terminal responsiveness.

| Item                                                   | Product decision               | Required local owner shape                                                                                          |
| ------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Non-git projects                                       | Explicit product mode required | Add durable `Project` mode and guard every git-only workflow instead of silently relaxing git assumptions.          |
| Docker/task-container runner profiles and auth sharing | Separate runner design         | Keep current task-container Compose preview architecture separate from future backend-owned agent runner isolation. |
| Theme/focus-mode presentation ideas                    | Design polish only             | Evaluate through local design tokens, accessibility, density, and terminal performance constraints.                 |

## Completion Rules

This range is closed only when:

- every `adopt-rewrite` row is either implemented locally or reclassified with evidence
- every `adopt-verify` row has evidence recorded here or in a follow-up ledger
- every redesign item has an explicit product decision
- targeted tests and required broader gates cover the owners touched
- browser-first preview exposure, task-container behavior, remote testing, reconnect/replay, and
  terminal responsiveness remain green for touched areas

Status: closed for selective upstream catch-up. Future product redesigns remain separately scoped
work and should not be treated as missed upstream changes.
