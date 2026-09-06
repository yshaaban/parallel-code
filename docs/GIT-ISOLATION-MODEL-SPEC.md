# Git Isolation Model Spec

Status: proposed and core implementation landed on `2026-04-01`

This document defines the local contract for the upstream isolation-model family:

- `8d30d7e`
- `95d0f06`
- `2b82e88`
- `3134143`

Classification:

- `reimplement on our architecture`

Primary owners:

- backend
- workflow / app
- store / projection
- presentation

Validation seams:

- `node / backend`
- `runtime / integration`
- `Solid / UI`

This is not a cherry-pick plan. It is the contract the landed implementation follows, and later
cleanup must keep satisfying it.

Current `main` status:

- explicit `defaultTaskGitIsolation`, `gitIsolation`, and task-level `baseBranch` are the primary
  durable fields
- current-branch task creation runs through backend/workflow owners, not renderer-owned branch
  preflight
- primary UI/task surfaces render `Project Root` terminology instead of the implementation-facing
  `current-branch` or legacy `Direct` names
- legacy compatibility shims still exist for persisted state, remote payloads, and some helper
  paths; later cleanup should remove those once the new model is the only live truth

## Historical Starting Point

Before this redesign landed, `main` modeled task git isolation through the legacy boolean
`directMode`, split across too many owners:

- project defaults use `defaultDirectMode`
- tasks persist `directMode?: true`
- worktree task creation was backend-owned
- direct/current-branch task creation was renderer-owned
- close/delete semantics branched on `task.directMode`
- task badges and labels still rendered the legacy terminology

That split was too hard to reason about.

The upstream direction is right: task git isolation and base-branch semantics should be explicit.
The local implementation still needs to follow this repo's ownership rules instead of copying
upstream file shape.

## Goals

- replace the ambiguous boolean `directMode` model with an explicit task git-isolation model
- make base-branch semantics explicit and durable
- keep current-branch admission in backend/workflow owners without mutating the shared checkout
- keep project defaults repo-scoped and task runtime semantics task-scoped
- keep UI labels aligned with the real behavior
- preserve backward compatibility for persisted local state

## Non-Goals

- no direct cherry-pick of upstream task/store/UI files
- no backend truth inferred from leaf UI components
- no handler-owned business logic for isolation semantics
- no silent persistence migration that changes task meaning without explicit defaults
- no promise that every existing task gets retrofitted with richer semantics beyond documented migration rules

## Proposed Model

### Project-scoped durable truth

Projects keep repo defaults:

- `baseBranch?: string`
- `branchPrefix?: string`
- `defaultTaskGitIsolation?: DefaultTaskGitIsolationMode`

`Project.baseBranch` remains the repo-scoped default branch used for new task creation and git fallback.

`Project.defaultTaskGitIsolation` replaces `defaultDirectMode`.

### Task-scoped durable truth

Tasks gain explicit git-isolation fields:

- `gitIsolation: TaskGitIsolationMode`
- `baseBranch?: string`

Where:

```ts
export type TaskGitIsolationMode = 'worktree' | 'current-branch' | 'existing-worktree';
export type DefaultTaskGitIsolationMode = Exclude<TaskGitIsolationMode, 'existing-worktree'>;
```

Task semantics:

- `Task.branchName`
  - the managed/imported task branch, or the project-root checkout observed at creation;
    a project-root value is historical context, not current checkout truth
- `Task.baseBranch`
  - the branch used as the diff/merge/review base for this task
- `Task.gitIsolation`
  - whether the task owns a managed worktree, reuses the project root, or imports an existing
    worktree

### Naming and terminology

User-facing labels should prefer:

- `Worktree`
- `Project Root`
- `Existing Worktree`

`current-branch` remains the internal Git-isolation value, but its user-facing behavior is working
in the repository's project root. Do not expose the legacy `Direct` label or describe the location
as merely a branch choice.

## Mode Semantics

### `worktree`

Behavior:

- creates an isolated branch + worktree
- `task.worktreePath` points at the created worktree
- `task.branchName` is the task branch
- `task.baseBranch` is the base branch the task branch was created from
- close/delete may remove the worktree and optionally delete the task branch according to project policy
- merge/rebase/review flows continue to operate as task-owned git workflows

Invariants:

- multiple worktree tasks per project are allowed
- task cleanup may mutate git/worktree state because the task owns that isolation

### `current-branch`

Behavior:

- reuses the project root instead of creating a worktree
- `task.worktreePath === project.path`
- `task.branchName` records the checked-out branch at creation; another shared-root writer may
  switch it later. Root badges and remote catalog labels must not present this snapshot as live
  branch truth
- `task.baseBranch` is still explicit and may differ from `task.branchName`
- close only stops agents/shells and clears task runtime state; it does not delete worktrees or task branches
- merge/delete-worktree assumptions must not run for this mode

Invariants:

- multiple `current-branch` tasks may share one canonical repository root, including through
  duplicate project records, symlink aliases, renderer clients, and concurrent requests
- the backend resolves the Git top-level path and records every task's membership in that canonical
  root; imported and managed worktrees retain exclusive ownership
- task creation has a client-generated operation id that the backend single-flights and replays;
  losing a browser response must not execute creation again or strand the task
- creation never checks out a branch, stashes files, or mutates the shared Git index; a requested
  base branch is review metadata, not permission to switch the checkout beneath another task
- files, index, and checked-out branch are shared; task/agent identity, command leases, lifecycle,
  and cleanup remain task-scoped. Closing one task must preserve every sibling's root registration
  and runtimes. Path-only lookup cannot grant authority over an arbitrary shared-root sibling
- review/diff/merge-base logic must not fall back to implicit "main" semantics when `task.baseBranch` is present

### `existing-worktree`

Behavior:

- imports an existing Git worktree instead of creating or owning one
- records external worktree ownership and the checked-out branch
- close stops task runtimes and watchers but never removes the worktree or branch

Invariants:

- the imported path must be a worktree of the selected project repository and cannot be the project
  root itself
- at most one task may register a canonical existing-worktree path at a time; aliases and
  concurrent imports share the backend admission owner
- multiple distinct linked worktrees from the same repository remain valid concurrent tasks

## Base-Branch Semantics

### Resolution rules for new tasks

When creating a task:

1. start with the repo/project default `Project.baseBranch`
2. allow the new-task workflow to choose an explicit base branch
3. normalize empty strings to `undefined` before they cross a transport boundary
4. if the effective base branch is still undefined, resolve it through the backend branch-detection owner
5. persist the resolved task base branch when known

Automatic detection uses a valid remote HEAD first (`origin`, or the sole configured remote),
repairing missing/stale remote HEAD metadata with a bounded, offline-tolerant Git request. It then
checks conventional `main`/`master` refs and the primary checkout's actual branch, including unborn
custom branches, before consulting `init.defaultBranch`. A managed worktree must not become its own
comparison base simply because its branch is checked out there. Explicit project/task defaults are
never silently replaced when unavailable: managed creation reports the invalid selection.

Branch labels resolve through explicit local/remote branch namespaces in the backend ref owner
for creation, status, history, and rebase, so a same-named tag cannot change branch intent and a
remote-only custom default remains usable without first creating a local branch. Remote-qualified
review bases preserve their remote identity. Committed review compares a local base with its
configured tracking remote (not always `origin`), so stale local refs do not resurrect changes already
landed upstream. Merging requires a resolved local branch: remote refs, tags, raw commit IDs,
revision expressions, and missing targets are rejected before mutation. The user must create/select
a local tracking branch rather than unknowingly land changes on detached HEAD; symbolic aliases
such as `HEAD` are resolved to their local branch name before checkout.
A merge cannot mutate the project checkout while any project-root task is registered, including
when its target is already checked out. Root admission and this guard share the repository lock;
the user closes the shared-root tasks before merging. A clean-tree check alone cannot prevent
their subsequent writes from entering a commit or being erased by recovery.

Failed merge, squash-commit, and rebase operations preserve Git's native recoverable checkout and
index state. The app never automatically resets, aborts, or switches back on failure. Error copy
identifies the operation/branch and directs the user to inspect and resolve the retained state;
this does not claim isolation from arbitrary external editors or Git hooks.

### Why task-level `baseBranch` is required

Project defaults can change after a task exists.

Task review, merge-base, diff, and reopen semantics should not silently change just because:

- a user edits the project default later
- a repo default branch changes upstream
- a persisted legacy task is reopened under a different project configuration

That means task-level `baseBranch` is durable truth, not just a transient dialog value.

## Ownership Plan

### Backend

Owns:

- branch listing and validation for isolated task bases
- base-branch detection fallback
- canonical shared-root task admission and current-checkout observation
- merge-base/diff/review semantics keyed by explicit task base branch
- close/delete semantics that differ by isolation mode

Likely files:

- `electron/ipc/git.ts`
- `electron/ipc/git-branch.ts`
- `electron/ipc/git-diff-ops.ts`
- `electron/ipc/git-mutation-ops.ts`
- `electron/ipc/task-workflows.ts`

### Handler / transport

Owns:

- typed request validation
- explicit `gitIsolation` and optional `baseBranch` request fields
- empty-string normalization at the boundary

Likely files:

- `electron/ipc/channels.ts`
- `electron/ipc/task-git-handlers.ts`
- `src/domain/renderer-invoke.ts`
- `electron/preload.cjs`

### Workflow / app

Owns:

- create-task orchestration
- current-branch creation intent without checkout sequencing
- mapping repo defaults plus explicit dialog selections into backend requests
- applying migration-safe defaults when legacy state is opened

Likely files:

- `src/app/task-lifecycle-workflows.ts`
- `src/app/task-workflows.ts`
- `src/app/new-task-dialog-workflows.ts`

### Store / projection

Owns:

- project and task types
- persistence codecs
- hydration/migration from `directMode` and `defaultDirectMode`
- projection helpers that answer mode-specific questions without leaving legacy booleans around

Likely files:

- `src/store/types.ts`
- `src/store/projects.ts`
- `src/store/persistence-codecs.ts`
- `src/store/persistence-task-hydration.ts`
- `src/store/persistence-projects.ts`

### Presentation

Owns:

- explicit isolation-mode selector UI
- explicit base-branch selector/input UI
- `Project Root` labels and help text for the internal `current-branch` mode
- task badges/info bars/title surfaces that reflect `gitIsolation`

Likely files:

- `src/components/NewTaskDialog.tsx`
- `src/components/EditProjectDialog.tsx`
- `src/components/TaskBranchInfoBar.tsx`
- `src/components/TaskTitleBar.tsx`
- `src/components/SidebarTaskRow.tsx`
- `src/remote/agent-presentation.ts`

## Migration Rules

### Project migration

- `defaultDirectMode: true` -> `defaultTaskGitIsolation: 'current-branch'`
- `defaultDirectMode: false | undefined` -> `defaultTaskGitIsolation: 'worktree'` or omitted if we preserve defaulting implicitly

### Task migration

- `directMode: true` -> `gitIsolation: 'current-branch'`
- `directMode: false | undefined` -> `gitIsolation: 'worktree'`
- missing `baseBranch` remains allowed for migrated tasks, but runtime owners must resolve fallback through the backend base-branch owner instead of using `task.branchName` as an implicit base
- the backend admission mirror registers an existing legacy `worktreePath` below a worktree under
  its nearest `.git` root; nested worktree roots stay distinct, and missing paths keep their exact
  saved identity instead of claiming an ancestor checkout

### UI migration

- remove user-facing `Direct` terminology
- replace direct-mode checkbox flows with isolation-mode selection
- keep close/delete copy aligned with the actual mode behavior

## Workflow Decisions

### Current-branch creation

Creation observes the current project-root checkout and never switches it. Users who want agents on
`main`, `master`, or a custom branch check out that branch before starting shared-root work. The
project base remains independent review metadata. A second task must not be rejected merely because
another task already uses the root, and must not change the first task's checkout.

### Branch selection

Isolated worktree creation may select a base branch. Project-root creation shows the shared-location
contract rather than offering a checkout selector. Default-branch detection belongs to the backend
and must handle custom names, missing or stale remote HEAD metadata, local-only repositories, and
unborn repositories without inventing a nonexistent `main` branch. Explicit project/task base
branches remain authoritative; missing refs fail visibly instead of silently choosing a new base.

## Acceptance Criteria

### Data model

- no new code depends on `directMode` or `defaultDirectMode` as primary truth
- project defaults and task isolation state use explicit named fields
- empty-string base branches cannot survive across IPC or persistence boundaries

### Backend correctness

- task diff/review/merge-base logic uses explicit task/project base-branch truth
- concurrent current-branch creation leaves the checked-out branch and dirty files unchanged
- close/delete semantics differ correctly by isolation mode

### Persistence

- legacy persisted state hydrates deterministically into the new model
- reopened tasks do not silently change diff semantics because a project default changed later

### UI consistency

- task creation and project editing use explicit isolation terminology
- title bars, badges, branch info, remote labels, and close dialogs render the new model consistently
- no leftover `Direct` wording remains except in migration-only compatibility code/comments

### Validation

- `node / backend`
  - base-branch normalization
  - migration/hydration behavior
  - checkout workflow and diff semantics
- `runtime / integration`
  - current-branch task creation
  - reopen behavior for migrated tasks
- `Solid / UI`
  - new task dialog
  - edit project dialog
  - task badges/info bars/title labels

## Implementation Order

1. add the explicit spec and parity docs
2. add new types plus migration helpers behind compatibility shims
3. move create-current-branch orchestration into backend/workflow owners
4. update task/project persistence and hydration
5. update UI labels/selectors and remove legacy checkbox wording
6. update review/diff/close surfaces to consume the new model directly
7. remove remaining compatibility shims once the new model is the only live truth

Current status:

- steps 1 through 6 are landed on current `main`
- step 7 compatibility removal remains intentionally open while persisted legacy state is supported

## Explicit Defers

This spec does not automatically take these adjacent upstream families:

- Docker isolation work
- terminal scroll/xterm changes
- font-capability work
- optional prompt-panel toggles
- Mermaid/file-viewer additions

Those remain tracked separately in the upstream parity docs.
