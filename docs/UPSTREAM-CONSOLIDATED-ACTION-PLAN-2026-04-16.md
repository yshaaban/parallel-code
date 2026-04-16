# Upstream Consolidated Action Plan 2026-04-16

This document is the consolidated action ledger for every upstream-only commit in
`b250446..91f00f4`.

Use it when:

1. deciding whether an upstream commit should be ported at all
2. deciding whether a behavior should be manually ported, reimplemented, or intentionally skipped
3. planning the next upstream intake batch without re-reading several older catch-up docs
4. explaining why a direct cherry-pick is the wrong tool even when the product behavior is still desirable

Use it with:

- [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [TESTING.md](./TESTING.md)
- [REVIEW-RULES.md](./REVIEW-RULES.md)
- [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md)
- [UPSTREAM-CATCHUP-2026-03-19.md](./UPSTREAM-CATCHUP-2026-03-19.md)
- [UPSTREAM-CATCHUP-2026-03-28.md](./UPSTREAM-CATCHUP-2026-03-28.md)
- [UPSTREAM-CATCHUP-2026-04-01.md](./UPSTREAM-CATCHUP-2026-04-01.md)

## Scope

- upstream branch reviewed: `origin/main`
- shared graph ancestor: `b250446`
- reviewed upstream head: `91f00f4`
- review date: `2026-04-16`
- upstream-only commits reviewed in this ledger: `125`
- newer upstream commits beyond `91f00f4`: `none`

This is not a new upstream delta review. It is a full-range consolidation pass over the already
documented upstream-only window so the fork has one current decision record for every commit in the
range.

## Decision Buckets

- `bring_with_modifications`
  - The behavior is still worthwhile, but it must land through the current local owners and browser-first runtime model.
- `ignore`
  - Either the behavior is already landed locally, already covered by newer local owners, or is intentionally not a parity target.
- `redesign`
  - The upstream behavior only makes sense in Electron-shaped or otherwise mismatched architecture. If we want it here, we need a local redesign first.

## Evaluation Guidelines

Every commit in this ledger was judged against the same rules:

1. Keep backend-owned truth in the backend. Do not port state ownership back into UI components, broad IPC files, or Electron-local controllers.
2. Preserve browser-first behavior and browser/server parity. Do not assume a single desktop runtime or single attached client.
3. Port by behavioral intent, not upstream file shape. A valid local implementation can live in different files if the owner is correct.
4. Prefer `ignore` over churn when the local architecture already covers the behavior.
5. Prefer `redesign` over direct ports when the upstream change depends on Electron-local Docker, permissions, or other desktop-only assumptions.
6. Treat merge wrappers, release tags, theme-only tweaks, formatting churn, and dependency-only bumps as non-parity unless they expose a real current-main gap.
7. Require an explicit owner and test seam before any `bring_with_modifications` work starts.

## Outcome Summary

- `118` commits: `ignore`
- `0` commits: `bring_with_modifications`
- `7` commits: `redesign`

The `118` `ignore` entries are not `118` product decisions to throw away. They break down into:

- `54` already covered locally
- `20` landed locally
- `44` intentionally skipped

The `44` intentionally skipped entries are mostly non-product churn or explicitly non-parity work:

- `15` merge-wrapper commits
- `6` release tags
- `3` docs and marketing commits
- `4` formatting or lint-only commits
- `7` theme or visual polish commits
- `2` Electron-only permission wideners
- `3` terminal-runtime commits that were rechecked with direct reproduction on `2026-04-16`
- `1` superseded intermediate git fix
- `2` dependency-only bumps

Current upstream status:

- there are no remaining upstream `bring_with_modifications` commits in `b250446..91f00f4`
- the active engineering blocker has shifted back to current-main runtime work in the browser
  render-stress lane

Current redesign-only family:

- `c646df4`
- `2be2c00`
- `064a4ea`
- `c456632`
- `511af86`
- `0a31fb7`
- `e96fba1`

Those seven commits all belong to the upstream Docker-isolation family. They should not be ported
directly into this fork.

The one deferred bug-fix family that required explicit re-verification was the terminal scroll and
fit trio:

- `60857bd`
- `e07d69d`
- `0882952`

That family was rechecked on `2026-04-16` against current `main` using:

- the existing browser restore lanes in [terminal-restore.spec.ts](../tests/browser/terminal-restore.spec.ts)
- the existing shell continuity lane in [terminal-render-stress.spec.ts](../tests/browser/terminal-render-stress.spec.ts)
- the focused live scrollback regression in
  [terminal-scroll-fit-preservation.spec.ts](../tests/browser/terminal-scroll-fit-preservation.spec.ts)

Result:

- current `main` did **not** reproduce the scrolled-back viewport resetting to the top while output
  and fit churn overlapped
- `60857bd`, `e07d69d`, and `0882952` therefore stay non-port decisions for now
- the current terminal issue that did reproduce is different: frame-budget pressure in the render
  stress suite, not viewport-loss during fit

## Per-Commit Ledger

### Commits 1-42

| #   | Commit    | Subject                                                                               | Current parity status   | Decision | Owner family       | Rationale                                                                                             |
| --- | --------- | ------------------------------------------------------------------------------------- | ----------------------- | -------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| 1   | `cc3f9c7` | `feat: scrolling diff viewer with search, collapse, and syntax highlighting`          | already covered locally | `ignore` | presentation       | Local review/diff surface already owns this; browser-first diff rendering stays in the shared viewer. |
| 2   | `7dc1f4f` | `feat(diff): add ask-about-code feature with inline Q&A cards`                        | already covered locally | `ignore` | workflow / app     | Ask-about-code already exists in the local review-session flow; renderer stays thin.                  |
| 3   | `34998db` | `feat(diff): add inline code review with annotations and agent submission`            | already covered locally | `ignore` | workflow / app     | Annotation submission is already centralized in local review-session owners.                          |
| 4   | `c126a48` | `fix(diff): address code review findings`                                             | already covered locally | `ignore` | workflow / app     | Follow-up review fixes are already reflected in the current review surfaces.                          |
| 5   | `9d3d79b` | `fix(diff): show truncation notice when ask-code response exceeds limit`              | already covered locally | `ignore` | workflow / app     | Ask-code truncation handling already exists in the local workflow path.                               |
| 6   | `a192f98` | `fix(diff): exclude binary files from diff view`                                      | already covered locally | `ignore` | backend            | Binary detection is backend-owned and already filters before renderer projection.                     |
| 7   | `31b7606` | `feat(plan): add plan review dialog with syntax highlighting and inline feedback`     | already covered locally | `ignore` | presentation       | Local plan/review dialog stack already owns this UI.                                                  |
| 8   | `ee8cd61` | `fix(merge): make commit list scrollable in merge dialog`                             | already covered locally | `ignore` | presentation       | Merge dialog/list scrollability already exists in local presentation owners.                          |
| 9   | `ae858a6` | `feat(push): stream live git push output in push dialog`                              | already covered locally | `ignore` | workflow / app     | Push progress already streams through backend/workflow/dialog ownership.                              |
| 10  | `d3bca6e` | `fix(plan): watch both .claude/plans and docs/plans for plan files`                   | already covered locally | `ignore` | backend            | Plan watcher already watches both canonical roots on the backend.                                     |
| 11  | `444a3ab` | `Merge branch 'task/push-experience-should-be-better-we'`                             | intentionally skipped   | `ignore` | docs / sanity only | Merge wrapper only; no independent behavior to port.                                                  |
| 12  | `9902a31` | `docs(readme): restructure around USPs and new tagline`                               | intentionally skipped   | `ignore` | presentation       | README and marketing copy only; no browser-first runtime effect.                                      |
| 13  | `fd3a749` | `Merge branch 'task/update-our-readme-to-reflect-on-our'`                             | intentionally skipped   | `ignore` | docs / sanity only | Merge wrapper only; underlying doc edits are non-parity.                                              |
| 14  | `5c5766b` | `feat(plan): float Review Plan button over inline plan and shrink dialog`             | already covered locally | `ignore` | presentation       | Local plan UI already has the floating affordance and dialog sizing.                                  |
| 15  | `bba36dd` | `fix(diff): detect binary files in untracked pseudo-diff generation`                  | already covered locally | `ignore` | backend            | Diff backend already handles binary detection before renderer filtering.                              |
| 16  | `2278c82` | `fix(plan): restore plan content from disk on app restart`                            | already covered locally | `ignore` | backend            | Plan persistence hydration already restores content from disk in the backend owner.                   |
| 17  | `588e34f` | `fix(plan): persist planFileName and restore exact file on restart`                   | already covered locally | `ignore` | backend            | Exact plan filename persistence is already in local restore code.                                     |
| 18  | `9ba275a` | `fix(plan): add path validation, log errors, unexport internal function`              | already covered locally | `ignore` | backend            | Backend plan owner already validates paths and logs failures.                                         |
| 19  | `7505c3f` | `fix(plan): remove opacity from floating Review Plan button`                          | already covered locally | `ignore` | presentation       | Local button styling already uses the opaque treatment.                                               |
| 20  | `5a781ff` | `Merge branch 'task/make-the-review-plan-button-floating'`                            | intentionally skipped   | `ignore` | docs / sanity only | Merge wrapper only; no independent behavior.                                                          |
| 21  | `408dd9d` | `fix(plan): use opaque hover background for Review Plan button`                       | already covered locally | `ignore` | presentation       | Local hover styling already matches the opaque contract.                                              |
| 22  | `30365c6` | `style(sidebar): write app title as "ParallelCode" in logo`                           | already covered locally | `ignore` | presentation       | Branding copy is already aligned in the sidebar shell.                                                |
| 23  | `8877e1c` | `Merge branch 'task/write-the-app-title-like-this'`                                   | intentionally skipped   | `ignore` | docs / sanity only | Merge wrapper only.                                                                                   |
| 24  | `f745408` | `feat(plan): ignore pre-existing plans in watcher detection`                          | already covered locally | `ignore` | backend            | Watcher startup already ignores pre-existing plans to preserve fresh-session semantics.               |
| 25  | `eb21feb` | `feat(dialogs): keyboard navigation for diff and plan viewer dialogs`                 | already covered locally | `ignore` | presentation       | Shared dialog owners already handle keyboard navigation in the local UI.                              |
| 26  | `524750c` | `fix(terminal): prevent paste duplication in shell terminals`                         | already covered locally | `ignore` | presentation       | Terminal shortcut and input ownership already prevents duplicate shell paste.                         |
| 27  | `9b31b20` | `chore(hooks): mirror CI checks in pre-commit and pre-push hooks`                     | already covered locally | `ignore` | workflow / app     | Local hook scripts already mirror CI checks for browser and backend parity.                           |
| 28  | `d9c5091` | `Merge branch 'task/mirror-our-remote-code-checks-with-a'`                            | intentionally skipped   | `ignore` | docs / sanity only | Merge wrapper only.                                                                                   |
| 29  | `5d5570b` | `1.0.0`                                                                               | intentionally skipped   | `ignore` | presentation       | Release tag only.                                                                                     |
| 30  | `7ab191e` | `fix(lint): resolve eqeqeq error and eliminate non-null assertions`                   | intentionally skipped   | `ignore` | presentation       | Lint cleanup only; no product behavior.                                                               |
| 31  | `3588b20` | `fix(ci): increase Node.js heap size for macOS release build`                         | already covered locally | `ignore` | workflow / app     | Release workflow already has the heap-size adjustment.                                                |
| 32  | `f19a6b1` | `Merge branch 'task/run-23066104225'`                                                 | intentionally skipped   | `ignore` | docs / sanity only | Merge wrapper only.                                                                                   |
| 33  | `b483e65` | `fix(plans): don't show stale plans in fresh sessions`                                | already covered locally | `ignore` | backend            | Backend watcher startup already suppresses stale plans.                                               |
| 34  | `dc5207c` | `Merge branch 'task/plan-detection-does-not-work-as'`                                 | intentionally skipped   | `ignore` | docs / sanity only | Merge wrapper only.                                                                                   |
| 35  | `4c0a250` | `feat(notifications): add native macOS desktop notifications for task status changes` | already covered locally | `ignore` | workflow / app     | Notification runtime already splits capability, sink, and browser fallback ownership.                 |
| 36  | `21c2105` | `style(ui): brighten Review Plan button with subtle accent tint`                      | intentionally skipped   | `ignore` | presentation       | Pure visual polish; browser-first behavior unchanged.                                                 |
| 37  | `d245dce` | `feat(nav): make shell toolbar buttons individually navigable via Alt+Arrow`          | already covered locally | `ignore` | store / projection | Focus and navigation projection already owns shell toolbar keyboard traversal.                        |
| 38  | `a75d0b3` | `1.1.0`                                                                               | intentionally skipped   | `ignore` | presentation       | Release tag only.                                                                                     |
| 39  | `65051a9` | `style: fix prettier formatting in 10 files`                                          | intentionally skipped   | `ignore` | presentation       | Formatting-only churn.                                                                                |
| 40  | `92836f7` | `feat(sidebar): group collapsed tasks under their projects`                           | already covered locally | `ignore` | store / projection | Sidebar projection already groups collapsed tasks by project; renderer does not recompute truth.      |
| 41  | `d8882c0` | `Merge branch 'task/collapsed-should-be-sorted-into-projects'`                        | intentionally skipped   | `ignore` | docs / sanity only | Merge wrapper only.                                                                                   |
| 42  | `cb511e5` | `style(themes): lighten non-minimal themes for better outdoor readability`            | intentionally skipped   | `ignore` | presentation       | Optional visual tweak; not a browser-first or backend-owned parity target.                            |

### Commits 43-84

| #   | Commit    | Subject                                                                                                                                         | Current parity status   | Decision   | Owner family          | Rationale                                                                                                                                      |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 43  | `851bc7c` | `Merge branch 'task/with-the-exclusion-of-the-minimal-theme'`                                                                                   | intentionally skipped   | `ignore`   | docs / sanity only    | Merge wrapper only; no standalone behavior to port.                                                                                            |
| 44  | `eb8ec58` | `feat(sidebar): ask for confirmation before deleting any project`                                                                               | already covered locally | `ignore`   | presentation          | Sidebar delete confirmation already exists in the local project flow.                                                                          |
| 45  | `5ff0add` | `feat(review): add comment editing and prevent scroll on comment add`                                                                           | already covered locally | `ignore`   | workflow / app        | Review-session comment editing and scroll stability are already represented locally.                                                           |
| 46  | `e326596` | `1.1.1`                                                                                                                                         | intentionally skipped   | `ignore`   | docs / sanity only    | Release tag only.                                                                                                                              |
| 47  | `b4b87b5` | `style(a11y): strengthen keyboard focus outlines for better visibility`                                                                         | already covered locally | `ignore`   | presentation          | Stronger focus outlines are already present in local styles.                                                                                   |
| 48  | `471ed09` | `fix(lint): ignore worktrees, claude, and dist-remote directories`                                                                              | already covered locally | `ignore`   | backend               | Ignore-rule update is already in the local repo config.                                                                                        |
| 49  | `4ec6351` | `Merge branch 'task/fix-all-linting-errors'`                                                                                                    | intentionally skipped   | `ignore`   | docs / sanity only    | Merge wrapper only.                                                                                                                            |
| 50  | `45f4633` | `fix(git): handle stale refs/remotes/origin/HEAD after default branch rename`                                                                   | already covered locally | `ignore`   | backend               | Local git backend already handles stale default-branch ref state.                                                                              |
| 51  | `f3abdb5` | `style(ui): make prompt placeholder more subtle when unfocused`                                                                                 | intentionally skipped   | `ignore`   | presentation          | Pure visual polish, not a parity target.                                                                                                       |
| 52  | `efdd90f` | `docs: add new vid`                                                                                                                             | intentionally skipped   | `ignore`   | docs / sanity only    | Docs-only.                                                                                                                                     |
| 53  | `8fac405` | `Merge branch 'task/i-changed-the-main-branch-on-one-of-my'`                                                                                    | intentionally skipped   | `ignore`   | docs / sanity only    | Merge wrapper only.                                                                                                                            |
| 54  | `52c3be8` | `docs: add intro YouTube video link to README`                                                                                                  | intentionally skipped   | `ignore`   | docs / sanity only    | Docs-only.                                                                                                                                     |
| 55  | `a737bc3` | `Addressed PR comments for notifications`                                                                                                       | already covered locally | `ignore`   | workflow / app        | Notification preference and click hardening already exists in the local runtime split.                                                         |
| 56  | `b541919` | `Merge pull request #20 from cledoux95/feature/macos-notifications`                                                                             | intentionally skipped   | `ignore`   | docs / sanity only    | Merge wrapper only.                                                                                                                            |
| 57  | `c646df4` | `feat: add Docker isolation mode for safer YOLO execution`                                                                                      | needs redesign          | `redesign` | backend               | Desktop-local Docker is the wrong shape here; if revived, it needs a backend-owned runner model.                                               |
| 58  | `2be2c00` | `improve: Docker isolation lifecycle, env forwarding, and UX`                                                                                   | needs redesign          | `redesign` | backend               | Same Docker family; browser-first flow needs a backend-owned rework, not a direct port.                                                        |
| 59  | `064a4ea` | `feat: add bundled Dockerfile and image build support`                                                                                          | needs redesign          | `redesign` | backend               | Container build support must be rethought for this web and server architecture.                                                                |
| 60  | `c456632` | `fix: address review findings across Docker isolation`                                                                                          | needs redesign          | `redesign` | backend               | Docker follow-up still carries the same Electron-local assumptions.                                                                            |
| 61  | `4bb68ae` | `Fix ESLint no-non-null-assertion warning in pty.ts`                                                                                            | intentionally skipped   | `ignore`   | backend               | Lint-only cleanup.                                                                                                                             |
| 62  | `fe92c17` | `Fix 7 review issues: preload allowlist, validation, branch uniqueness, plan watcher leak, docker defaults, notifications, async docker checks` | already covered locally | `ignore`   | backend               | Non-Docker fixes are already covered locally; the Docker-only tail stays deferred.                                                             |
| 63  | `511af86` | `feat: add Docker isolation mode for safer YOLO execution`                                                                                      | needs redesign          | `redesign` | backend               | Duplicate Docker-family feature; same browser-first mismatch as `c646df4`.                                                                     |
| 64  | `38a6ea3` | `feat(diff): add expandable leading/trailing context gaps with auto-expand threshold`                                                           | already covered locally | `ignore`   | presentation          | Diff-view context-gap behavior is already in the local scrolling diff owner.                                                                   |
| 65  | `3393f34` | `fix(notifications): harden desktop notification implementation`                                                                                | already covered locally | `ignore`   | handler / transport   | Notification transport hardening already exists in the local runtime and handler split.                                                        |
| 66  | `53a6deb` | `feat(git): show unstaged files reliably in changed files section`                                                                              | already covered locally | `ignore`   | backend               | Backend diff owner already surfaces unstaged files reliably.                                                                                   |
| 67  | `0c31c9b` | `fix(memory): cap unbounded buffers and stop leaked plan watchers`                                                                              | already covered locally | `ignore`   | backend               | Buffer caps and watcher cleanup are already in the local backend owners.                                                                       |
| 68  | `4959b29` | `feat(projects): block non-git folders with dialog feedback`                                                                                    | already covered locally | `ignore`   | workflow / app        | Project workflow already rejects non-git folders with feedback.                                                                                |
| 69  | `7b3580c` | `fix(ui): scroll selected file into view during keyboard navigation`                                                                            | already covered locally | `ignore`   | presentation          | Changed-files navigation already auto-scrolls the selected item.                                                                               |
| 70  | `98ebef8` | `fix(ui): limit open-in-editor click target to branch name and folder path`                                                                     | already covered locally | `ignore`   | presentation          | Branch-info click target already stays narrow in the local UI.                                                                                 |
| 71  | `0b1850b` | `fix(remote): handle CJS default export in dynamic qrcode import`                                                                               | already covered locally | `ignore`   | presentation          | Remote-connect modal already handles the CJS default export path.                                                                              |
| 72  | `99189ec` | `fix(ui): prevent direct-mode checkbox race when collapsed task exists`                                                                         | already covered locally | `ignore`   | presentation          | New-task dialog race is already fixed locally.                                                                                                 |
| 73  | `2430b97` | `refactor: broad code quality improvements across frontend and backend`                                                                         | already covered locally | `ignore`   | workflow / app        | The surviving prompt-send, channel-lifecycle, storage, and persisted-agent-default behaviors already map to stronger current owners on `main`. |
| 74  | `b9dc240` | `style: fix prettier formatting in 4 files`                                                                                                     | intentionally skipped   | `ignore`   | docs / sanity only    | Formatting-only churn.                                                                                                                         |
| 75  | `c190073` | `fix(ui): retain focus and scroll into view when moving task with keyboard`                                                                     | already covered locally | `ignore`   | store / projection    | Focus-retention behavior already exists in the local navigation and projection owners.                                                         |
| 76  | `4792390` | `fix: update macOS icon sizes (#21)`                                                                                                            | already covered locally | `ignore`   | presentation          | Icon assets already match upstream head.                                                                                                       |
| 77  | `fc57cfd` | `feat: dynamic system font detection for terminal font picker (#29)`                                                                            | intentionally skipped   | `ignore`   | presentation          | Full system-font enumeration is not a current parity target here.                                                                              |
| 78  | `8d30d7e` | `feat: replace boolean \`directMode\` with \`GitIsolationMode\` and flexible base branch (#30)`                                                 | landed locally          | `ignore`   | workflow / app        | The staged git-isolation migration already exists in the fork.                                                                                 |
| 79  | `7d534ce` | `fix(ui): make Ctrl+0 zoom reset work globally`                                                                                                 | landed locally          | `ignore`   | presentation          | Global zoom-reset shortcut is already in place.                                                                                                |
| 80  | `c40d743` | `fix(git): use three-dot diff in computeBranchDiffStats for correct merge-base comparison`                                                      | landed locally          | `ignore`   | backend               | Backend diff owners already use merge-base semantics.                                                                                          |
| 81  | `60857bd` | `fix(ui): prevent terminal scroll jumping to top on new output`                                                                                 | intentionally skipped   | `ignore`   | runtime / integration | Terminal scroll behavior is deferred unless we reproduce a current-main bug.                                                                   |
| 82  | `88b5b8f` | `feat(ui): enable soft line wraps in diff view`                                                                                                 | landed locally          | `ignore`   | presentation          | Soft-wrap diff rendering is already implemented locally.                                                                                       |
| 83  | `0882952` | `fix(ui): upgrade xterm.js to beta for scroll fixes`                                                                                            | intentionally skipped   | `ignore`   | runtime / integration | Xterm beta bump is deferred without a reproduced bug and browser-lab proof.                                                                    |
| 84  | `cd1ad01` | `refactor: decompose TaskPanel into focused sub-components`                                                                                     | landed locally          | `ignore`   | presentation          | TaskPanel is already decomposed into focused subcomponents.                                                                                    |

### Commits 85-125

| #   | Commit    | Subject                                                                                 | Current parity status   | Decision   | Owner family        | Rationale                                                                                                                                                  |
| --- | --------- | --------------------------------------------------------------------------------------- | ----------------------- | ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 85  | `0a31fb7` | `fix(docker): install agent CLIs in Docker image`                                       | intentionally skipped   | `redesign` | backend             | Docker image behavior is upstream Electron and container shape; if we ever revive it here, it has to become backend-owned runner logic, not a direct port. |
| 86  | `777f1d7` | `fix(ui): count only committed lines in merge view totals`                              | landed locally          | `ignore`   | presentation        | The fork already projects committed-only totals from backend merge-base math; the UI side is just a projection.                                            |
| 87  | `e96fba1` | `fix(docker): resolve container startup failures and improve UX`                        | intentionally skipped   | `redesign` | backend             | Same deferred Docker family; browser-first and server-owned architecture would need a new runner design, not upstream Docker UX copy.                      |
| 88  | `95d0f06` | `fix(types): replace legacy directMode with gitIsolation property`                      | landed locally          | `ignore`   | store / projection  | The git-isolation migration is already landed across store, backend, workflow, and task surfaces.                                                          |
| 89  | `fb86cc5` | `fix(ui): wrap agent selector buttons instead of clipping overflow (#32)`               | landed locally          | `ignore`   | presentation        | The agent-selector overflow and layout fix is already in the local presentation owner.                                                                     |
| 90  | `a81d24d` | `fix(git): compare diffs against most up-to-date branch ref`                            | already covered locally | `ignore`   | backend             | Branch refs and diff bases already resolve in the backend git owners.                                                                                      |
| 91  | `ccd9fe5` | `Merge branch 'task/for-diff-are-we-comparing-against-736b24'`                          | intentionally skipped   | `ignore`   | docs / sanity only  | Merge wrapper only; no standalone product behavior to port.                                                                                                |
| 92  | `e07d69d` | `fix(ui): restore scroll position preservation around terminal fit()`                   | intentionally skipped   | `ignore`   | workflow / app      | Terminal scroll and fit behavior is intentionally deferred unless we reproduce a current-main bug on the current terminal owners.                          |
| 93  | `9333bfd` | `feat(ui): add roving tabindex keyboard nav to new task dialog`                         | already covered locally | `ignore`   | presentation        | The new-task dialog already has keyboard navigation in the local owner.                                                                                    |
| 94  | `cdf80e6` | `fix(ui): reset selectedProjectId on dialog reopen to ensure branches load`             | already covered locally | `ignore`   | workflow / app      | Dialog reopen initialization already resets the selected project selection in the local workflow.                                                          |
| 95  | `faef5c3` | `fix(git): use closest merge-base for changed files diff and pass baseBranch prop`      | already covered locally | `ignore`   | backend             | Changed-files diff and base-branch behavior already comes from the backend merge-base owner.                                                               |
| 96  | `63ef1da` | `Merge branch 'task/changed-files-shows-a-lot-of-changes-c709eb'`                       | intentionally skipped   | `ignore`   | docs / sanity only  | Merge wrapper only.                                                                                                                                        |
| 97  | `abb5d62` | `1.2.0`                                                                                 | intentionally skipped   | `ignore`   | docs / sanity only  | Release tag only.                                                                                                                                          |
| 98  | `2b82e88` | `fix: branch dropdown, diff base branch, and direct mode auto-checkout (#34)`           | landed locally          | `ignore`   | workflow / app      | The git-isolation and current-branch migration is already implemented in the local workflow and backend split.                                             |
| 99  | `8d6e3cb` | `fix(git): fall back to HEAD instead of branch name when merge-base fails`              | already covered locally | `ignore`   | backend             | The backend git owners already normalize merge-base failure to a stable HEAD fallback.                                                                     |
| 100 | `cda05c3` | `Merge branch 'task/if-master-branch-has-commits-not-in-the-0c4159'`                    | intentionally skipped   | `ignore`   | docs / sanity only  | Merge wrapper only.                                                                                                                                        |
| 101 | `23ae2bb` | `fix(merge): detect branch mismatch before merging to prevent silent data loss`         | landed locally          | `ignore`   | backend             | Merge safety is already enforced before side effects in the backend merge owner.                                                                           |
| 102 | `c42b921` | `fix(ui): show uncommitted count even when all files are uncommitted`                   | landed locally          | `ignore`   | presentation        | The changed-files footer already shows uncommitted counts even when committed totals are zero.                                                             |
| 103 | `0269812` | `fix(git): use main-tip diff for one-way changed files view`                            | intentionally skipped   | `ignore`   | backend             | This one-way diff shape was superseded by later merge-base-backed backend logic.                                                                           |
| 104 | `ab434ae` | `1.2.1`                                                                                 | intentionally skipped   | `ignore`   | docs / sanity only  | Release tag only.                                                                                                                                          |
| 105 | `39aff3c` | `fix(autosave): include branchName in persisted snapshot (#36)`                         | already covered locally | `ignore`   | store / projection  | Branch name is already persisted in the local snapshot model.                                                                                              |
| 106 | `bc8a127` | `feat: add Zenburnesque theme (#35)`                                                    | intentionally skipped   | `ignore`   | presentation        | Theme polish is not a parity target in the browser-first architecture.                                                                                     |
| 107 | `a350209` | `feat(settings): add toggle for prompt input panel (#47)`                               | intentionally skipped   | `ignore`   | presentation        | The upstream desktop-shaped hide-toggle is not planned for the current browser shell or task-panel focus model.                                            |
| 108 | `21701eb` | `feat(themes): add Midnight theme (#41)`                                                | intentionally skipped   | `ignore`   | presentation        | Theme-only polish.                                                                                                                                         |
| 109 | `9ce6abe` | `feat(terminal): open .md file links in built-in markdown viewer (#45)`                 | landed locally          | `ignore`   | workflow / app      | Terminal `.md` routing now stays on the owned viewer path in the terminal-session owner.                                                                   |
| 110 | `38a16b5` | `fix(ui): remove backdrop blur from dialog overlays (#46)`                              | intentionally skipped   | `ignore`   | presentation        | Visual polish only.                                                                                                                                        |
| 111 | `774ffe2` | `feat(terminal): add Cmd+Arrow and Shift+Enter keyboard shortcuts (#39)`                | landed locally          | `ignore`   | presentation        | Terminal shortcut policy already lives in the local shared terminal-session owner.                                                                         |
| 112 | `cec983b` | `feat(terminal): paste clipboard images as temp file paths (#42)`                       | landed locally          | `ignore`   | handler / transport | Typed clipboard-image handling already landed through the Electron IPC seam and browser fallback.                                                          |
| 113 | `246ef40` | `fix(git): use merge-base for branch log and worktree status`                           | landed locally          | `ignore`   | backend             | Branch log and worktree status already use merge-base semantics in the backend git owners.                                                                 |
| 114 | `3134143` | `refactor(ui): rename "Direct" git isolation mode to "Current Branch"`                  | landed locally          | `ignore`   | presentation        | The local task surfaces already use the current-branch terminology.                                                                                        |
| 115 | `0bc4d65` | `fix: harden IPC handlers, sanitize markdown, fix focus grid, reduce theme duplication` | landed locally          | `ignore`   | presentation        | The safe markdown renderer and the relevant IPC hardening already landed locally; unrelated theme and IPC pieces are outside the parity target.            |
| 116 | `c40a5f6` | `fix(git): use merge-base for one-way diffs instead of main-tip`                        | already covered locally | `ignore`   | backend             | One-way diffs already resolve from merge-base in the local backend owner.                                                                                  |
| 117 | `933931a` | `feat(terminal): require Ctrl+click to open file and web links`                         | landed locally          | `ignore`   | workflow / app      | Modifier-click gating already belongs to the local terminal-session owner.                                                                                 |
| 118 | `b51c0b7` | `feat(electron): grant microphone and clipboard permissions (#40)`                      | intentionally skipped   | `ignore`   | handler / transport | Electron permission widening is not a browser-first target for this fork.                                                                                  |
| 119 | `69b0a4b` | `chore(deps-dev): bump tar in the npm_and_yarn group across 1 directory (#18)`          | intentionally skipped   | `ignore`   | docs / sanity only  | Dependency bump only.                                                                                                                                      |
| 120 | `a37b958` | `fix(terminal): open .md file links in viewer instead of externally (#48)`              | landed locally          | `ignore`   | workflow / app      | The same terminal `.md` viewer routing gap is now closed locally through the terminal-session owner.                                                       |
| 121 | `e56a9fc` | `feat(markdown): render mermaid diagrams in plan viewer (#44)`                          | landed locally          | `ignore`   | presentation        | Mermaid now renders only inside the owned plan-viewer pipeline with local presentation and markdown owners.                                                |
| 122 | `7a9565b` | `fix(electron): grant clipboard-write permission for terminal copy`                     | intentionally skipped   | `ignore`   | handler / transport | Electron-specific permission widening is outside the default browser-first path.                                                                           |
| 123 | `2f1d498` | `1.3.0`                                                                                 | intentionally skipped   | `ignore`   | docs / sanity only  | Release tag only.                                                                                                                                          |
| 124 | `b944064` | `fix(ui): improve diff preview for added and deleted files (#49)`                       | already covered locally | `ignore`   | presentation        | The worthwhile bounded diff-preview behavior already lives in the current `ScrollingDiffView` owner.                                                       |
| 125 | `91f00f4` | `chore(deps-dev): bump the npm_and_yarn group across 1 directory with 3 updates (#50)`  | intentionally skipped   | `ignore`   | docs / sanity only  | Dependency bump only.                                                                                                                                      |

## Detailed Action Plan Status

### Phase 1: Owned terminal and viewer gaps

Status:

- `landed`

Result:

- `9ce6abe` and `a37b958` are now absorbed through the terminal-session owner
- terminal `.md` links route through the shared in-app markdown viewer with the existing
  modifier-click and worktree-safety rules

### Phase 2: Bounded diff and plan-viewer improvements

Status:

- `landed`

Result:

- `e56a9fc` is now absorbed through the owned plan-viewer pipeline
- `b944064` is closed as already covered locally by the current bounded diff presentation owners

### Phase 3: Optional prompt input panel affordance

Status:

- `not_planned`

Result:

- `a350209` is intentionally skipped for the current browser shell

### Phase 4: Narrow subset from the broad refactor

Status:

- `landed`

Result:

- `2430b97` is closed as already covered on current `main`
- no broad refactor churn was imported

### Phase 5: Docker family

Commits:

- `c646df4`
- `2be2c00`
- `064a4ea`
- `c456632`
- `511af86`
- `0a31fb7`
- `e96fba1`

Status:

- `not_planned`

Result:

- the whole family stays redesign-only unless product direction changes
- there is no direct port queue left for these seven commits

Required redesign rules:

- isolation must be backend-owned
- browser clients must remain stateless observers and controllers, not container owners
- runtime capability detection must not assume Electron-only affordances
- validation must include backend integration coverage and multi-client browser scenarios

## What To Ignore By Default

The following categories should remain non-work unless current main exposes a fresh gap:

- merge wrapper commits
- release tags
- README and marketing docs
- formatting-only changes
- theme-only changes
- Electron-only permission widening
- terminal scroll and xterm beta churn without a reproduced local bug
- already covered or already landed local behavior families

## How To Use This Ledger Going Forward

1. When new upstream commits land, append them to a new dated catch-up doc rather than rewriting this file.
2. When a formerly covered or intentionally skipped commit changes status on current `main`, update
   both this file and [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md).
3. When a redesign track becomes active, replace the single redesign family note with a dedicated local spec before implementation.
4. If current-main behavior changes enough that an `ignore` entry becomes stale, reclassify that one commit explicitly instead of reopening the whole range.
