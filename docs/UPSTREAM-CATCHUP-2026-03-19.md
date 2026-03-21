# Upstream Catch-up Review 2026-03-19

This document records the upstream review for `a75d0b3..b541919`.

Scope:

- upstream branch reviewed: `origin/main`
- review date: `2026-03-19`
- local head at review time: `cf21f87`
- commits reviewed in range: `19`
- non-merge commits with real behavior or config changes: `13`

Use this together with [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md). That document keeps the
high-level reviewed-head status. This document captures the detailed per-commit analysis and the
bring-over spec that guided the later ports from this reviewed range.

## Status Update 2026-03-21

The reviewed batch in this document is no longer an open implementation queue.

Since this review was written, the remaining must-bring items from the `2026-03-13` to
`2026-03-17` upstream range were either:

- ported into this fork in the correct local owners
- confirmed as already covered locally
- or intentionally left deferred where the behavior is not a parity target

In particular, the `45f4633` stale `origin/HEAD` fix later landed locally in
[electron/ipc/git-branch.ts](../electron/ipc/git-branch.ts) via `3ee46a0`, so any bring-over
ordering below should now be read as historical review-time guidance, not as an open queue.

Use [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) as the current parity ledger. Keep this
document as the per-commit design record for why those ports were classified the way they were.

## Range Summary

The reviewed range breaks into these feature families:

1. desktop notifications
2. sidebar task ordering and project-delete confirmation
3. review comment editing and diff scroll stability
4. stale `origin/HEAD` git handling
5. tooling ignore rules
6. low-risk UI polish and style-only changes
7. docs, release tags, and merge wrappers

Merge wrapper commits with no independent behavior:

- `d8882c0`
- `851bc7c`
- `4ec6351`
- `8fac405`
- `b541919`

## Commit-by-Commit Review

### `4c0a250` `feat(notifications): add native macOS desktop notifications for task status changes`

- Decision: bring
- Classification: `reimplement on our architecture`
- Primary owner: `workflow / app`
- Validate at: `node / backend`, `runtime / integration`, `Solid / UI`

Desired parity spec:

- emit a desktop notification when a task transitions into a review-ready or waiting state while the desktop window is unfocused
- debounce/batch notifications so rapid task churn does not spam the user
- clicking a notification should focus the window and activate the first relevant task
- browser mode must remain supported, with the same task-status policy delivered through browser notifications when capability and permission allow it

Local integration notes:

- do not recreate the upstream `src/store/desktopNotifications.ts` pattern; that makes a store-owned side-effect runtime the policy owner
- start the shared watcher from the session/runtime layer, likely near [desktop-session.ts](../src/app/desktop-session.ts) or [desktop-session-startup.ts](../src/app/desktop-session-startup.ts)
- keep the Electron-native delivery side effect behind a typed IPC seam in the backend
- model browser capability, permission, and multi-tab suppression explicitly instead of treating browser mode as a no-op

Expected local files:

- [electron/ipc/register.ts](../electron/ipc/register.ts) or a narrower notification/window handler owner
- [electron/ipc/channels.ts](../electron/ipc/channels.ts)
- [src/domain/renderer-invoke.ts](../src/domain/renderer-invoke.ts)
- [src/app/desktop-session.ts](../src/app/desktop-session.ts)
- [src/app/task-notification-runtime.ts](../src/app/task-notification-runtime.ts)
- [src/app/task-notification-capabilities.ts](../src/app/task-notification-capabilities.ts)
- [src/app/task-notification-sinks.ts](../src/app/task-notification-sinks.ts)
- [src/store/types.ts](../src/store/types.ts)
- [src/store/ui.ts](../src/store/ui.ts)
- [src/store/persistence-codecs.ts](../src/store/persistence-codecs.ts)
- [src/store/persistence-load.ts](../src/store/persistence-load.ts)
- [src/components/SettingsDialog.tsx](../src/components/SettingsDialog.tsx)

Key divergence notes:

- our current app/session startup is no longer [App.tsx](../src/App.tsx)-owned
- our IPC layer is typed through [renderer-invoke.ts](../src/domain/renderer-invoke.ts), so upstream’s raw preload widening is the wrong port shape
- browser-mode support is a hard constraint, so Electron-only behavior must not leak into shared renderer paths

### `a737bc3` `Addressed PR comments for notifications`

- Decision: bring with `4c0a250`
- Classification: `reimplement on our architecture`
- Primary owner: `workflow / app`
- Validate at: `node / backend`, `runtime / integration`, `Solid / UI`

Bring-over additions beyond `4c0a250`:

- desktop notifications must be user-toggleable
- the setting must persist across restart
- the fire-and-forget notification IPC should not be modeled as a response-bearing invoke
- notification-click payload parsing should be defensive

Local integration notes:

- persist the new setting in the same owner family as `showPlans`, `autoTrustFolders`, and the Hydra desktop settings
- if we need fire-and-forget IPC, add it through the existing typed IPC surface instead of copying upstream’s untyped `window.electron.ipcRenderer.send(...)` use
- keep the click routing in workflow/app or navigation owners, not inside a settings or leaf component

### `65051a9` `style: fix prettier formatting in 10 files`

- Decision: skip
- Classification: `skip/defer`
- Validate at: `docs / sanity only`

Reason:

- this is formatting churn around files that have already diverged locally
- there is no product behavior to preserve
- any real behavior from this area should be ported from the originating feature commit instead

### `92836f7` `feat(sidebar): group collapsed tasks under their projects`

- Decision: bring
- Classification: `reimplement on our architecture`
- Primary owner: `store / projection`
- Validate at: `Solid / UI`

Desired parity spec:

- collapsed tasks should render under their project heading instead of under a separate global `Collapsed` section
- project counts should include both active and collapsed tasks
- keyboard navigation in the sidebar should use the same visual ordering as the rendered list
- `Enter` / `Right` on a collapsed task in sidebar focus mode should restore it instead of trying to navigate into a hidden panel
- orphaned tasks should still group under `Other`, with active first and collapsed second

Local integration notes:

- add a shared sidebar-order projection owner instead of recomputing the ordering separately in rendering and focus navigation
- wire the same projection into [SidebarTaskList.tsx](../src/components/sidebar/SidebarTaskList.tsx) and [focus.ts](../src/store/focus.ts)
- keep drag/reorder semantics on the same projection family too; do not let `Sidebar.tsx` fall back
  to raw `store.taskOrder` indices once grouped rendering has landed
- keep collapsed-task restore behavior in existing task/workflow owners; do not let the list leaf start owning task lifecycle policy

Expected local files:

- new [src/store/sidebar-order.ts](../src/store/sidebar-order.ts)
- [src/components/sidebar/SidebarTaskList.tsx](../src/components/sidebar/SidebarTaskList.tsx)
- [src/components/Sidebar.tsx](../src/components/Sidebar.tsx)
- [src/store/focus.ts](../src/store/focus.ts)
- [src/components/Sidebar.test.tsx](../src/components/Sidebar.test.tsx)
- [src/store/focus.test.ts](../src/store/focus.test.ts)

Key divergence notes:

- our sidebar is already split into [SidebarProjectsSection.tsx](../src/components/sidebar/SidebarProjectsSection.tsx) and [SidebarTaskList.tsx](../src/components/sidebar/SidebarTaskList.tsx)
- the right port is one shared projection owner, not another round of inline grouping logic in a large component

### `cb511e5` `style(themes): lighten non-minimal themes for better outdoor readability`

- Decision: defer
- Classification: `skip/defer`
- Primary owner: `presentation`
- Validate at: `Solid / UI`

Reason:

- the change is purely visual and our theme system has already diverged from upstream through later local UI work
- this should not be treated as a parity requirement before the functional upstream gaps are closed

Future port notes:

- if we want the behavior later, port it as a token-level theme refresh through [src/lib/theme.ts](../src/lib/theme.ts), [src/lib/monaco-theme.ts](../src/lib/monaco-theme.ts), and [src/styles.css](../src/styles.css)
- do not copy the exact upstream numbers without a fresh visual pass in both desktop and browser mode

### `eb8ec58` `feat(sidebar): ask for confirmation before deleting any project`

- Decision: bring
- Classification: `manual port`
- Primary owner: `presentation`
- Validate at: `Solid / UI`

Desired parity spec:

- deleting any project should require confirmation, not only projects with open tasks
- the dialog copy and confirm label should adapt depending on whether the project still owns tasks

Local integration notes:

- keep project deletion behavior where it already lives; only move the confirmation policy into the sidebar/project presentation flow
- because [SidebarProjectsSection.tsx](../src/components/sidebar/SidebarProjectsSection.tsx) is already the project-row owner, the dialog state can stay in [Sidebar.tsx](../src/components/Sidebar.tsx) while the button remains in the project section leaf

Expected local files:

- [src/components/Sidebar.tsx](../src/components/Sidebar.tsx)
- [src/components/sidebar/SidebarProjectsSection.tsx](../src/components/sidebar/SidebarProjectsSection.tsx)
- [src/components/Sidebar.test.tsx](../src/components/Sidebar.test.tsx)

### `5ff0add` `feat(review): add comment editing and prevent scroll on comment add`

- Decision: bring
- Classification: `reimplement on our architecture`
- Primary owner: `workflow / app`
- Validate at: `Solid / UI`

Desired parity spec:

- existing review annotations should be editable in place from both inline comment cards and the review sidebar
- editing should update the existing annotation, not delete/recreate it
- adding the first comment should not jerk the diff scroll position when the sidebar opens

Local integration notes:

- put annotation mutation in the review-session owner, not inside [ReviewSidebar.tsx](../src/components/ReviewSidebar.tsx) or [ReviewCommentCard.tsx](../src/components/ReviewCommentCard.tsx)
- extend [createReviewSession](../src/app/review-session.ts) with `updateAnnotation(...)`, then thread that through the shared review-surface session and sidebar props
- inline and sidebar review editing may keep local draft state, but the final local shape should stay
  intentionally thin: trim/save validation belongs at the leaf boundary, while actual annotation
  replacement stays centralized in `updateAnnotation(...)`
- keep the current shared review-surface bootstrap intact; apply the behavior through [review-surface-session.ts](../src/components/review-surface-session.ts) and [review-sidebar-actions.ts](../src/components/review-sidebar-actions.ts), not by reintroducing per-surface divergence
- the scroll-preservation fix belongs in [ScrollingDiffView.tsx](../src/components/ScrollingDiffView.tsx), where the container scroll ownership already lives

Expected local files:

- [src/app/review-session.ts](../src/app/review-session.ts)
- [src/app/task-review-session.ts](../src/app/task-review-session.ts)
- [src/components/review-surface-session.ts](../src/components/review-surface-session.ts)
- [src/components/review-sidebar-actions.ts](../src/components/review-sidebar-actions.ts)
- [src/components/ReviewCommentCard.tsx](../src/components/ReviewCommentCard.tsx)
- [src/components/ReviewSidebar.tsx](../src/components/ReviewSidebar.tsx)
- [src/components/ScrollingDiffView.tsx](../src/components/ScrollingDiffView.tsx)
- [src/components/DiffViewerDialog.tsx](../src/components/DiffViewerDialog.tsx)
- [src/components/PlanViewerDialog.tsx](../src/components/PlanViewerDialog.tsx)
- [src/components/review-panel/ReviewPanelDiffPane.tsx](../src/components/review-panel/ReviewPanelDiffPane.tsx)
- focused tests for all three review surfaces

Key divergence notes:

- upstream used [ReviewProvider.tsx](../src/components/ReviewProvider.tsx); we already replaced that ownership with [review-session.ts](../src/app/review-session.ts) and [review-surface-session.ts](../src/components/review-surface-session.ts)
- the right port is at the review-session owner seam, not a file-shape port

### `e326596` `1.1.1`

- Decision: skip
- Classification: `skip/defer`
- Validate at: `docs / sanity only`

Reason:

- release tag only
- the meaningful work is already captured by the surrounding commits

### `b4b87b5` `style(a11y): strengthen keyboard focus outlines for better visibility`

- Decision: bring
- Classification: `manual port`
- Primary owner: `presentation`
- Validate at: `Solid / UI`

Desired parity spec:

- keyboard focus rings should remain clearly visible across dialogs, buttons, selects, prompt inputs, and focused panels

Local integration notes:

- port this as a targeted accessibility pass in [src/styles.css](../src/styles.css)
- sanity-check the new focus ring strength against our newer shell chrome, terminal-startup chip, and review surfaces

### `471ed09` `fix(lint): ignore worktrees, claude, and dist-remote directories`

- Decision: bring
- Classification: `manual port`
- Primary owner: `tooling/config`
- Validate at: `docs / sanity only`

Desired parity spec:

- ESLint and Prettier should not traverse generated build output or local worktree/Claude copies that create noisy failures

Local integration notes:

- our config already ignores `dist-remote/**` in ESLint but not in Prettier
- we still need the `.worktrees/**` and `.claude/**` ignore entries
- this is architecture-neutral and can land independently

Expected local files:

- [.prettierignore](../.prettierignore)
- [eslint.config.js](../eslint.config.js)

### `45f4633` `fix(git): handle stale refs/remotes/origin/HEAD after default branch rename`

- Decision: bring
- Classification: `manual port`
- Primary owner: `backend`
- Validate at: `node / backend`

Desired parity spec:

- main-branch detection must not return a stale upstream default branch after a remote default-branch rename
- if `refs/remotes/origin/HEAD` is stale, refresh it and then fall back to known branch-name heuristics

Local integration notes:

- upstream changed [electron/ipc/git.ts](../electron/ipc/git.ts); our branch/main detection now lives in [electron/ipc/git-branch.ts](../electron/ipc/git-branch.ts)
- port the behavior into that narrower owner instead of reviving logic in the broader git module
- add regression coverage in [electron/ipc/git-branch.test.ts](../electron/ipc/git-branch.test.ts) for stale `origin/HEAD`, refreshed `origin/HEAD`, and no-network fallback cases

### `f3abdb5` `style(ui): make prompt placeholder more subtle when unfocused`

- Decision: defer
- Classification: `skip/defer`
- Primary owner: `presentation`
- Validate at: `Solid / UI`

Reason:

- low-value visual polish only
- the prompt panel has already diverged locally through later focus, Hydra, and terminal-adjacent work

### `efdd90f` `docs: add new vid`

- Decision: skip
- Classification: `skip/defer`
- Validate at: `docs / sanity only`

Reason:

- marketing/docs asset only
- no product behavior or architecture implication

### `52c3be8` `docs: add intro YouTube video link to README`

- Decision: skip
- Classification: `skip/defer`
- Validate at: `docs / sanity only`

Reason:

- README/docs only
- no parity value for the fork runtime

## Historical Bring-over Order

1. `45f4633` stale `origin/HEAD` handling, later landed locally via `3ee46a0`
2. `5ff0add` review comment editing and scroll stability
3. `92836f7` collapsed tasks grouped under projects
4. `eb8ec58` confirm deleting any project
5. `4c0a250` + `a737bc3` desktop notifications
6. `471ed09` tooling ignore rules
7. `b4b87b5` focus-outline accessibility pass
8. optional visual follow-ups only after the functional parity work lands

## Why This Order

- the git fix is small, high-value, and backend-contained
- the review change adds real product capability and maps cleanly to our newer review-session architecture
- the sidebar changes are product-visible but contained to store/presentation seams
- desktop notifications are desirable, but they are the easiest place to regress browser mode if we port by upstream shape
- config and visual polish should not block the higher-value behavior ports

## Port Guardrails For This Batch

- do not port the notifications watcher into a broad store module or back into [App.tsx](./src/App.tsx)
- do not widen the renderer IPC surface with raw untyped send/listener helpers unless the typed request/event maps are updated first
- do not let the sidebar render order and keyboard order diverge; both must read from the same derived projection
- do not reintroduce review-surface bootstrap drift; annotation editing must flow through the shared review-session owner
- do not port the git fix by copying old broad git-module shape; the local owner is [git-branch.ts](./electron/ipc/git-branch.ts)
