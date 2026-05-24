# Upstream Catch-up Review 2026-05-24

This document records the intake review for the upstream range that landed after the
`2026-05-08` catch-up pass.

Scope:

- upstream branch reviewed: `origin/main`
- upstream head at review time: `6097655`
- previous reviewed upstream head: `7aaf640`
- local head at review time: `fe1ddd5`
- review date: `2026-05-24`
- shared graph ancestor with upstream: `b250446`
- commits reviewed in range: `54`

Use this with [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md). This fork is intentionally
selective: port behavior and tests into the local owner, not upstream file shape.

## Review Method

The range was split across three read-only subagent passes and then reconciled against the local
architecture rules:

- first slice: `b10447a..6496544`
- middle slice: `ed1557e..21f7e57`
- late slice: `0d6fd38..6097655`

The final disposition below is the reconciled local decision. When an upstream change is marked
`adopt-rewrite`, that means bring the behavior by remapping it into this fork's current owners. It
does not mean cherry-pick the upstream files.

## Disposition Key

- `adopt-rewrite`: useful behavior that should be implemented in local architecture owners
- `adopt-verify`: likely already covered or close to covered, but needs evidence before closing
- `redesign`: useful product direction, but the upstream implementation conflicts with local
  browser-first ownership or needs a larger local design
- `inspire`: presentation or ergonomics signal that can guide future local polish, with no parity
  requirement
- `skip`: release, merge-shape, screenshot, or upstream-specific change that should not be ported

## Summary

Do not merge or rebase `origin/main` directly. This upstream range contains a large coordinator MCP
feature, multi-agent task UI work, theme and updater product surfaces, broad settings rewrites, and
panel/sidebar refactors. Several of those are useful product directions, but direct merge shape
would bypass local backend/workflow/store/presentation boundaries.

The near-term bring/remap queue is smaller and concrete:

1. Diff and changed-file correctness: blank-area double-click guard, working-tree line counts, and
   diff chrome selection cleanup where still applicable.
2. Prompt and terminal interaction reliability: multiline bracketed-paste-aware auto-send,
   terminal-family row focus navigation, and task-reorder keybinding conflict removal.
3. Window/session safety: running-session close dialog with Cancel and renderer close-handling ack.
4. Backend/IPC hardening: strict branch validation, atomic write helper cleanup, and defensive
   copying of default agent args.
5. Sidebar/panel state polish: collapsed-project focus/navigation behavior, finite persisted panel
   weights, reset behavior, and responsive auto-size caps.
6. Dependency/security hygiene: review and refresh the `ws`, `mermaid`, and `qs` updates through
   the local lockfile workflow.
7. Status/attention verification: prove local shell activity, ready/review attention, busy
   precedence, and QR rendering behavior in the current presentation owners.

Large product decisions should be handled as separate local designs:

- multi-agent task terminals and task-level lifecycle semantics
- MCP/coordinator orchestration
- filterable branch selection during task creation
- appearance mode, custom themes, and CSS editor persistence
- in-app auto-update

## Landed Local Implementation

This catch-up range landed without a direct upstream merge in these local commits:

- `bafbd61` `fix: harden backend git operations`
- `cc445b4` `fix: acknowledge renderer close handling`
- `7e01cbe` `fix: improve task UI reliability`
- `c4cbbef` `chore: refresh reviewed dependency pins`

The implementation keeps the original dispositions but closes the bring/remap and verify queue
through local owners:

- backend review truth: merge-base-to-working-tree changed-file counts, unstaged-only count
  coverage, strict branch validation, git-status freshness/error metadata, atomic write hardening,
  and defensive agent argument copies
- review and diff ergonomics: blank-area diff pointer guard, preserved diff text selection, and
  changed-file chrome selection cleanup; changed-file open-in-editor remains inspiration-only
- terminal and prompt reliability: multiline bracketed-paste prompt dispatch, line-count submit delay,
  terminal-family focus preservation/fallback, and task-reorder shortcuts moved to page navigation
  chords
- window, remote, and mobile safety: three-choice running-session close behavior, renderer
  close-handled acknowledgement, QR stale-result guard, and visible QR loading/error fallback
- sidebar, panel, and attention behavior: hidden Projects focus cleanup, collapsed-project keyboard
  navigation, invalid panel-size guards, double-click reset, responsive request caps, shell activity
  attention, busy-over-review precedence, and review-specific awaiting-review label
- dependency/security hygiene: local lock graph resolves `ws@8.21.0`, `mermaid@11.15.0`, and
  `qs@6.15.2`; broad static-analysis adoption is deferred as a separate tooling decision
- redesign-only work remains intentionally deferred: multi-agent task terminals,
  MCP/coordinator, filterable branch picker, appearance/custom themes, auto-update, non-git
  projects, and Docker runner ideas

Validation passed: targeted node and Solid owner tests, `npm run typecheck`, `git diff --check`,
`npm ls --package-lock-only ws mermaid qs`, `npm run test:browser:terminal`,
`npm run check -- --pretty false`, and `npm test`.

## Commit Ledger

| Commit                                                    | Disposition   | Local decision                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b10447a` fix diff blank-area double-click                | adopt-rewrite | Bring the behavior into `ScrollingDiffView`: prevent blank-area double-click/mousedown from acting on the last diff row or opening inline review. Add a focused UI test around blank-space double-click.                                                      |
| `d4d856e` align changed line counts with working tree     | adopt-rewrite | Remap into local git diff owners. All-mode changed-file counts should reflect merge-base to working tree, including dirty files on top of committed changes, instead of mixing committed numstat with separate uncommitted counts.                            |
| `4c52e11` improve task status reliability                 | adopt-rewrite | Upstream avoids ready status from stale, pending, or failed git state. Local task status is richer, but `WorktreeStatus` still needs freshness/error semantics through backend snapshots and `task-git-status`, not component polling.                        |
| `1226f27` fix Codex prompt auto-send                      | adopt-rewrite | Local `task-prompt-workflows` still writes single-line prompt text plus carriage return as one atomic path. Bring multiline bracketed-paste-aware send readiness through prompt workflow/terminal owners so initial prompts cannot stick or submit too early. |
| `c4540f5` status dots track shell activity                | adopt-verify  | Local shell output is already marked as shell activity and `task-presentation-status` includes shell supervision. Keep or add tests proving shell activity affects sidebar/task attention in the local status model.                                          |
| `9a1a76e` fix uncommitted changed-file stats              | adopt-verify  | Local review uses `GetProjectDiff` with `unstaged` mode and untracked-file helpers rather than upstream's sentinel path. Verify unstaged-only review stats and avoid adding duplicate IPC.                                                                    |
| `d603d00` changed-file open-editor hover button           | inspire       | Local already has editor-open helpers, but adding a row action is optional review-surface polish. Do not treat as parity unless users need faster file opening from changed-files rows.                                                                       |
| `88e5a26` dependency bump: npm/yarn group                 | adopt-verify  | Review through local dependency workflow. Upstream bumps `mermaid` and a transitive `uuid`; local currently tracks its own lock graph and should refresh only after audit/test validation.                                                                    |
| `c9ffd6b` non-git project worktree scan                   | skip          | Local product flow rejects non-git project roots today. Do not add non-git worktree scan behavior until non-git projects have a local architecture/product design.                                                                                            |
| `1162c18` double-click AI info bar copies last prompt     | inspire       | Local double-click behavior reuses the last prompt into an empty prompt input. Keep that intentional local UX unless product wants upstream's copy-only behavior.                                                                                             |
| `556d552` multiple agents per task                        | redesign      | Local types have `agentIds`, but the UI, command lease, supervision, persistence, focus, and terminal layout model are not upstream's. Design this as a local multi-agent task capability before implementation.                                              |
| `8c04b1d` terminal control spacing                        | inspire       | Presentation-only. Consider as task-panel density polish, but avoid importing upstream `TaskAITerminal` structure.                                                                                                                                            |
| `6d7b3ce` pagination dot hit area                         | skip          | The upstream focus-mode/titlebar pagination surface does not exist locally. No local action.                                                                                                                                                                  |
| `e45634c` merge pagination-dot branch                     | skip          | Merge-shape commit for the skipped pagination-dot surface. No local action.                                                                                                                                                                                   |
| `325a314` upstream release 1.9.0                          | skip          | Upstream release metadata. Keep fork versioning independent.                                                                                                                                                                                                  |
| `5328e34` prioritize tasks in dense sidebar               | inspire       | Useful density signal only. Local sidebar/project/task organization has diverged and should keep local focus and attention ownership.                                                                                                                         |
| `f3dcb9c` standalone terminal font size                   | adopt-verify  | Local standalone `TerminalPanel` has no hardcoded upstream font-size path. Verify terminal typography settings still apply consistently.                                                                                                                      |
| `0c93d63` terminal row focus navigation                   | adopt-rewrite | Bring the intent into local `focus` owners: preserve terminal-family focus when navigating task rows, including shell-to-no-shell and AI-terminal fallback cases. Add focus-navigation tests.                                                                 |
| `cd79f2a` scale bracketed-paste delay by line count       | adopt-rewrite | Implement with the `1226f27` prompt-send work. Delay/submit timing should scale with prompt size and live in the local prompt/terminal readiness seam.                                                                                                        |
| `775512b` diff viewer related changes                     | adopt-verify  | Audit local diff/list chrome for accidental text selection during row actions. Add `user-select: none` only where it protects interaction without degrading diff text selection.                                                                              |
| `d174694` Cancel option for running-session close dialog  | adopt-rewrite | Bring the multi-choice close decision into local window/session owners. Add renderer close-handling acknowledgement so backend force-close timers are cleared only after the renderer handles the close request.                                              |
| `d08a744` Linux pagination dots clickable                 | skip          | Upstream-specific titlebar pagination surface is absent locally. No local action.                                                                                                                                                                             |
| `24678c7` task-reorder shortcuts shadow word-select       | adopt-rewrite | Local defaults still use `Cmd/Ctrl+Shift+Arrow` for task move actions. Move task reorder defaults away from text-selection shortcuts and update keybinding tests/help copy.                                                                                   |
| `6496544` intermittent mobile connect QR rendering        | adopt-verify  | Local already has QR generation invalidation and stale-result tests. Verify the blank-render case; add placeholder/error state only if local rendering can still go blank.                                                                                    |
| `ed1557e` themes settings tab and appearance mode         | redesign      | Appearance mode is a product surface requiring local store/persistence/runtime-shell design. Do not port the broad `SettingsDialog` rewrite. Separately extract the close-handling ack behavior covered by `d174694`.                                         |
| `2d49608` WCAG contrast fixes in built-in themes          | adopt-rewrite | Run a local contrast audit and update affected tokens/Monaco theme mappings where local themes fail. Bring `accent-hover-bg` style separation only through local theme owners.                                                                                |
| `f1949ca` atomic writes, validators, static analysis      | adopt-rewrite | Bring the security principles selectively: shared atomic filesystem helper, strict IPC validators, and scoped static-analysis config. Do not import the upstream `electron/mcp` ownership shape.                                                              |
| `326c9f5` strict validator at IPC call sites              | adopt-rewrite | Replace loose local branch validation at task-git call sites with a strict `git check-ref-format` equivalent and classify invalid input as `BadRequestError`. Cover create/merge/delete branch paths.                                                         |
| `7062cd6` status-dot review precedence and tooltips       | adopt-verify  | Local presentation status is owned by `task-presentation-status` and `TaskActivityIndicator`, not upstream `StatusDot`. Verify ready/review attention and tooltip/title coverage in current components.                                                       |
| `b3c6b8e` status-dot tooltip behavior                     | adopt-verify  | Same status family. Add focused local tests only if current `TaskActivityIndicator`/badge coverage does not prove tooltip and precedence behavior.                                                                                                            |
| `e97cce3` status-dot screenshot                           | skip          | Upstream screenshot artifact for a component not used in the local sidebar row. No local action.                                                                                                                                                              |
| `afed0fd` MCP orchestration backend                       | redesign      | Major product/architecture feature. If desired, design a local coordinator around typed handlers, backend-owned task orchestration, replayable state, browser/mobile parity, command leases, and bounded concurrency.                                         |
| `077fa42` bump `ws`                                       | adopt-verify  | Bump `ws` through local package-lock workflow and run websocket/browser transport tests.                                                                                                                                                                      |
| `6adb56e` proportional absorber pins and panel reset      | adopt-rewrite | Local panel model differs but shares persisted-size risk. Add finite/stale persisted-size cleanup and double-click reset in local `ResizablePanel`/tiling owners.                                                                                             |
| `6bc4b7d` panel review feedback                           | adopt-rewrite | Fold upstream finite/positive guards and absorber cleanup intent into the local proportional-size implementation, not upstream component shape.                                                                                                               |
| `3ccff18` coordinator UI and launch fixes                 | redesign      | Depends on the coordinator backend redesign. UI should be built on local workflow/control owners rather than embedded into upstream `PromptInput` shape.                                                                                                      |
| `35cd01b` coordinator polish nits                         | inspire       | Carry the constraints into any future coordinator design: quote TOML env keys and clamp max concurrent subtasks.                                                                                                                                              |
| `5099957` coordinator polish nits                         | inspire       | Future coordinator design should keep status DTOs narrow, backend events idempotent, and hydration able to attach existing agents.                                                                                                                            |
| `21f7e57` coordinator arg tests after rebase              | adopt-verify  | Independent useful fix: return a defensive copy of default skip-permission args in local `agents` owner and add a regression test.                                                                                                                            |
| `0d6fd38` filterable branch picker in New Task            | redesign      | Local task creation uses project base-branch ownership and has no New Task branch picker. Design branch selection around local project/base-branch workflows before implementation.                                                                           |
| `577421b` branch picker PR feedback                       | redesign      | Same branch-picker family. Preserve accessibility lessons if the local feature is designed: display labels, bounded query results, keyboard scroll, and explicit loading state.                                                                               |
| `ce8f97f` branch picker focus/reopen/stale issues         | redesign      | Same branch-picker family. Future design must include stale-branch clearing, inline retry, and submit blocking while branch data is invalid.                                                                                                                  |
| `1198686` custom themes with CSS editor and AI prompt     | redesign      | Requires local persistence validation, browser/Electron parity, theme injection, terminal theme overlay, and safe CSS editing design. Do not port the broad upstream implementation.                                                                          |
| `1d5ad96` collapsible Projects section                    | adopt-verify  | Local already has collapsible project sections and persistence. Verify existing sidebar-section tests rather than porting upstream `Sidebar` changes.                                                                                                         |
| `2245957` collapsible Projects polish                     | adopt-rewrite | Bring missing local behavior: clear project focus on collapse and skip hidden projects in keyboard navigation when the projects section is collapsed.                                                                                                         |
| `3811d58` in-app auto-update                              | redesign      | Needs local runtime-shell design: Electron-only backend authority, browser unsupported state, fork release target, typed IPC, and release-channel policy.                                                                                                     |
| `9befcd6` cap auto-resized panel height                   | adopt-rewrite | Add responsive caps for request-sized panels in local owners, especially task steps, without importing upstream's old `maxAutoSize` shape.                                                                                                                    |
| `cb0e886` InfoBar allowOverflow for add-agent menu        | skip          | Local AI terminal has no add-agent menu inside `InfoBar`; no action unless a future local menu is placed there.                                                                                                                                               |
| `b57d6d5` side-by-side multi-agent task terminals         | redesign      | Depends on local multi-agent task design. Include terminal width detection and focus semantics if that product work proceeds.                                                                                                                                 |
| `2910879` bump `qs`                                       | adopt-verify  | Refresh through local dependency/audit workflow. Local `qs` is transitive, so validate the actual lock graph before changing package metadata.                                                                                                                |
| `1416350` merge status-dot branch                         | skip          | Merge-shape commit. Evaluate only the concrete child status-dot commits already listed.                                                                                                                                                                       |
| `9f73281` preserve busy precedence for needs-review tasks | adopt-verify  | Verify local review/ready badges do not override live/busy activity indicators. Keep the current local precedence if already proven.                                                                                                                          |
| `5e88bf5` review precedence in attention state            | adopt-rewrite | Local task-step `awaiting_review` currently maps to general ready/next-step attention. Consider a review-specific presentation state or badge, with active-agent precedence tests.                                                                            |
| `6097655` merge status-dot tooltip branch                 | skip          | Merge-shape commit. No direct merge-port; tooltip/status behavior is covered by child commits and local status owners.                                                                                                                                        |

## Implementation Queue

### Bring Or Remap

These are the concrete behavior ports that should be implemented in local owners:

- `b10447a`: diff blank-area double-click guard.
- `d4d856e`: changed-file line counts from merge-base to working tree.
- `4c52e11`: git/task status freshness and error semantics.
- `1226f27` plus `cd79f2a`: multiline bracketed-paste-aware prompt auto-send with line-count
  delay.
- `0c93d63`: terminal-family focus navigation across task rows.
- `d174694`: Cancel close decision and renderer close-handling acknowledgement.
- `24678c7`: task-reorder keybinding defaults that do not shadow word selection.
- `2d49608`: local contrast/token fixes if audit confirms failures.
- `f1949ca` plus `326c9f5`: atomic writes and strict IPC validators in local owners.
- `6adb56e` plus `6bc4b7d` plus `9befcd6`: local panel persistence/reset/responsive cap hardening.
- `2245957`: collapsed-project focus and navigation behavior.
- `5e88bf5`: possible review-specific attention state for task steps.

### Verify Or Close

These should be checked with focused evidence before closing:

- `c4540f5`, `7062cd6`, `b3c6b8e`, `9f73281`: local shell activity, tooltip/title, busy, and
  ready/review precedence.
- `9a1a76e`: unstaged-only changed-file stats.
- `88e5a26`, `077fa42`, `2910879`: dependency refreshes through local lockfile and audit workflow.
- `f3dcb9c`: standalone terminal font-size inheritance.
- `6496544`: mobile QR generation stale-result and placeholder/error behavior.
- `1d5ad96`: existing collapsible projects persistence and tests.
- `21f7e57`: defensive copy of default skip-permission args.

### Redesign Before Build

These are not direct-port candidates:

- `556d552`, `b57d6d5`: multi-agent task model and side-by-side terminal UI.
- `afed0fd`, `3ccff18`, `35cd01b`, `5099957`: MCP/coordinator backend and UI.
- `0d6fd38`, `577421b`, `ce8f97f`: filterable branch picker.
- `ed1557e`, `1198686`: appearance mode and custom themes.
- `3811d58`: auto-update.

### Skip Or Inspiration Only

Skip release, merge-shape, screenshot, and absent-surface commits. Treat presentation-only commits
as optional polish after local product priorities are clear:

- skip: `6d7b3ce`, `e45634c`, `325a314`, `d08a744`, `e97cce3`, `cb0e886`, `1416350`,
  `6097655`
- inspire: `d603d00`, `1162c18`, `8c04b1d`, `5328e34`, `35cd01b`, `5099957`
