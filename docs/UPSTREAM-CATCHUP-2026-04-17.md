# Upstream Catch-up Review 2026-04-17

This document records the upstream review for the new delta on `origin/main` that was not present
on local `main` when the `2026-04-16` parity pass froze.

Scope:

- upstream branch reviewed: `origin/main`
- upstream head at review time: `a0f5280`
- previous reviewed upstream head: `91f00f4`
- review date: `2026-04-17`
- local head at review time: `5fbfae7`
- shared graph ancestor: `b250446`
- commits reviewed in range: `71`

Use this together with [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md), which remains the
high-level parity ledger. The older [UPSTREAM-CONSOLIDATED-ACTION-PLAN-2026-04-16.md](./UPSTREAM-CONSOLIDATED-ACTION-PLAN-2026-04-16.md)
stays as the historical ledger for the prior frozen range `b250446..91f00f4`.

## Summary

- `origin/main` advanced from `91f00f4` to `a0f5280`.
- The first-pass intake counts for this delta were:
  - `26` `bring_with_modifications`
  - `18` `ignore_or_covered`
  - `27` `redesign`
- The implemented outcome is narrower:
  - the direct-port git / changed-files / terminal / settings subset is now landed locally or
    explicitly closed without a direct port
  - the steps family remains redesign-only
  - Docker-mode preference remains redesign-only under this fork's browser-first architecture
  - `aa92062` was confirmed already covered by existing browser-lab coverage

## Bring With Modifications

### Family 1: Git, changed-files, and commit navigation

Bucket: `bring_with_modifications`

Commit intake:

- `5f66a24` `feat(git): add local branch existence check and improve worktree creation validation (#61)`
- `8f2ea49` `feat(ui): add file tree view to changed files list (#68)`
- `e2822ea` `fix(git): filter out files already merged into main from changed files view`
- `da88063` `fix(git): compare against both local and remote main when filtering phantom files`
- `ba03382` `fix(git): include uncommitted files when filtering diff view`
- `9f66625` `fix(git): harden diff dialog to show all changed files`
- `08c721a` `Claude/add commit navigation buttons 6 t3ja (#71)`
- `3bae1c3` `fix(commit-nav): hide nav when no commits, fix single-commit opacity`
- `efdd863` `fix(commit-nav): show nav for all worktree tasks, not just when commits exist`
- `3a961c6` `fix(commits): fix commit selection buttons in Changed Files panel`
- `734da25` `fix(commits): fix commit nav buttons not always refreshing file list`
- `4fb2569` `fix(changed-files): use muted color for folder names`
- `182282d` `fix(changed-files): match folder color to committed files, tighten chevron gap`

Rationale:

- this family is now the cleanest parity queue from the new delta
- the useful behavior belongs in current backend/git owners plus the changed-files projection and
  commit-nav presentation owners
- the changed-files and commit-navigation fixes should be implemented by behavior, not by copying
  upstream file shape

Current outcome on this fork:

- landed locally:
  - `5f66a24`
  - `8f2ea49`
  - `e2822ea`
  - `da88063`
  - `ba03382`
  - reason: backend git owners now validate local branch existence before worktree creation, filter
    phantom files against both local and remote `main`, keep uncommitted files visible, and render
    the changed-files tree through a presentation-only `ChangedFilesList` owner with directory
    collapse and keyboard navigation
- closed without a direct port:
  - `9f66625`
  - `08c721a`
  - `3bae1c3`
  - `efdd863`
  - `3a961c6`
  - `734da25`
  - `4fb2569`
  - `182282d`
  - reason: this fork does not expose upstream's commit-selection button surface in the changed-files
    panel; bounded file navigation already lives in the review toolbar owner, and the remaining
    folder-color / spacing polish is intentionally handled by local presentation rather than as
    commit-by-commit parity work

### Family 2: Terminal, shell, settings, and bounded UI ergonomics

Bucket: `bring_with_modifications`

Commit intake:

- `78c3126` `feat(settings): add font smoothing toggle (#60)`
- `9cb3d1b` `fix(mermaid): add error handling, singleton init, and race condition guard`
- `85b5b90` `Add default terminal font size setting`
- `fb6b081` `fix: resolve shell tabs via OS user shell (#58)`
- `eb165c3` `fix(shortcuts): allow ESC to close dialogs when terminal is focused (#55)`
- `83c677c` `feat(new-task-dialog): move isolation text to tooltips, widen dialog, tighten checkbox spacing`
- `cabbc6b` `feat(copilot): add first-class Copilot CLI support`
- `47b76ee` `Fix task creation reload in dev (#17)`
- `3f9900b` `fix: log swallowed errors instead of silently dropping them`
- `6ff5b57` `feat(diff): add per-dialog zoom via Ctrl+Scroll in diff viewer`
- `bfac21e` `fix(zoom): add keyboard shortcuts for zoom in/out`
- `83bbb98` `feat: improve horizontal overflow cues and off-screen task attention (#52)`
- `4ea5a94` `fix(ui): restore double-click-last-prompt when prompt input is hidden`

Rationale:

- these are the useful runtime and presentation improvements from the new delta that still fit our
  current browser-first owners
- the zoom and shell shortcuts should stay centralized in shared shortcut and runtime owners
- the dialog, overflow, and notification-adjacent polish should be implemented through the current
  presentation / workflow surfaces, not by bringing over upstream component shape directly

Current outcome on this fork:

- landed locally:
  - `78c3126`
  - `9cb3d1b`
  - `85b5b90`
  - `fb6b081`
  - `eb165c3`
  - `83c677c`
  - `3f9900b`
  - `6ff5b57`
  - `bfac21e`
  - reason: current owners now persist terminal font size and font smoothing through the shared
    store, route shell tabs through the OS account shell, keep dialog-safe Escape centralized in
    shortcut policy, harden Mermaid loading and remote websocket errors, widen the new-task dialog
    with tooltip guidance, and add bounded diff zoom plus global keyboard zoom control
- closed without a direct port:
  - `47b76ee`
  - `83bbb98`
  - `4ea5a94`
  - `cabbc6b`
  - reason: browser cold-bootstrap and client-session reconciliation already own the dev-refresh
    restore path, task attention is already projected through canonical supervision owners, the
    current browser shell does not expose the upstream hidden-prompt interaction surface, and
    first-class Copilot CLI support remains a separate provider/product decision rather than a
    parity requirement in this pass

## Ignore Or Covered

### Family 3: Dependencies, merge wrappers, docs-only changes, and already-covered behavior

Bucket: `ignore_or_covered`

Commit intake:

- `aacd8bd` `chore(deps-dev): bump electron (#51)`
- `d66b1bf` `chore(deps-dev): bump the npm_and_yarn group across 1 directory with 3 updates (#65)`
- `46e9c3b` `fix(deps): resolve dependabot security vulnerabilities`
- `aa92062` `fix(terminal): preserve scroll position across fit() resize calls`
- `19efb9b` `chore(deps): bump the npm_and_yarn group across 1 directory with 2 updates (#69)`
- `5b8fad6` `1.5.0`
- `e4aec881` `Merge branch 'task/our-new-buttons-for-selecting-commit-faed43'`
- `85d25f8` `Merge branch 'task/the-commit-selection-buttons-in-Changed-8965ab'`
- `28060c0` `Merge branch 'task/our-new-buttons-in-changed-files-panel-9cdfa4'`
- `713dc32` `Merge branch 'task/any-ideas-to-improve-our-steps-panel-4bc251'`
- `59ed165` `Merge branch 'task/ctrl-to-zoom-out-works-but-ctrl-062012'`
- `f4de359` `Merge branch 'task/zoom-9266d8'`
- `648f5a2` `style: increase all font sizes by 1px`
- `3becf1b` `docs(zoom): explain why zoom-in needs three shortcut registrations`
- `b48ecca` `fix(changed-files): reduce indentation step from 10px to 8px per depth level`
- `043a820` `fix(changed-files): only show folder stats when collapsed`
- `8f58dd4` `chore(deps-dev): bump follow-redirects (#72)`

Rationale:

- these items are either maintenance churn, merge wrappers, docs-only polish, dependency bumps, or
  behavior already covered by current owners and browser-lab tests
- the terminal scroll-preservation upstream item is already functionally covered on current `main`
- the font-size and folder-stats tweaks are not priority parity targets for this fork

## Redesign

### Family 4: Steps / progress tracking panel

Bucket: `redesign`

Commit intake:

- `df89387` `feat(steps): add steps.json progress tracking panel`
- `956a821` `feat(new-task): add tooltip explaining steps tracking checkbox`
- `a9c000b` `fix(steps): resume step updates after awaiting_review`
- `612590a` `fix(steps): ignore arrow keys when alt is held to avoid conflict with panel navigation`
- `075a48f` `refactor(steps): move panel below terminal, improve typography and layout`
- `e7819cc` `feat(steps): add Interacting indicator, fix timestamp, remove toggle button`
- `5509606` `refactor(steps): clean up post-review findings`
- `d26c824` `fix(steps): rename indicator to 'Waiting for next step'`
- `8b3c07f` `refactor(steps): extract WaitingIndicator, memoize latestStep, use Date.parse`
- `60ce955` `feat: improve on steps prompt`
- `11d3a1e` `feat(steps): add starting status and update prompt for before/after entries`
- `c2ebc2d` `feat(steps): truncate summary/detail and skip empty steps in navigation`
- `7404cf8` `fix(steps): inject instruction into first manual prompt when no initial prompt given`
- `9eeaaeb` `feat(steps): EM-perspective instruction with next field and sub-agent guidance`
- `a532346` `style(steps): wrap next field in backticks for visual distinction`
- `dc85459` `feat(steps): auto-size steps panel to fit current step card`
- `0660b9b` `feat(steps): click suggested next action to pre-fill prompt input`
- `4e160ef` `fix(steps): auto-stamp timestamps on read instead of relying on AI clock`
- `503cc25` `fix(steps): always overwrite timestamps on new entries with host clock`
- `70c60cb` `fix(steps): preserve timestamps across app restart (#74)`
- `a0f5280` `feat(steps): polish UI and add sub-agent + terminal-jump support (#75)`

Rationale:

- the steps panel is a new product surface with a backend/workflow shape that does not map cleanly
  to a direct upstream port in this fork
- the useful concepts to preserve are the task-progress history, next-action guidance, prompt
  seeding, host-stamped timestamps, and sub-agent-aware display
- the implementation target should be a local redesign, not upstream file-shape reuse

### Family 5: Browser-first architecture conflicts

Bucket: `redesign`

Commit intake:

- `8412463` `fix(ui): respect user's choice to disable Docker mode (#64)`
- `bfad545` `fix(zoom): use webFrame.setZoomFactor to keep terminals sharp`
- `9c1d872` `refactor(zoom): remove per-panel zoom in favour of global zoom only`
- `0f12e55` `fix(steps): guard against undefined timestamp in normalizeIsoTimestamp`
- `b9732b` `fix(steps): preserve explicit false when steps tracking is unchecked`

Rationale:

- these commits depend on upstream assumptions that do not fit the current browser-first owners
- Docker remains redesign-only in this fork
- the zoom-model commits conflict with the current global zoom ownership already established here
- the timestamp and unchecked-state commits belong with the steps redesign rather than as direct
  ports

## Notes

- The catch-up outcome is now narrower than the first-pass intake:
  - the direct-port git / changed-files / terminal / settings subset is landed locally
  - the remaining changed-files commit-nav and browser-shell utility items are explicitly closed
    without a direct port
  - the steps family remains redesign-only
- Keep [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) as the current top-level ledger and use
  this document as the per-commit intake record for `91f00f4..a0f5280`.
