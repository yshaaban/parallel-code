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
- move current-branch checkout/orchestration out of renderer heuristics and into backend/workflow owners
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
  - the branch the task is actively operating on
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
- `task.branchName` is the checked-out branch the task will operate on
- `task.baseBranch` is still explicit and may differ from `task.branchName`
- close only stops agents/shells and clears task runtime state; it does not delete worktrees or task branches
- merge/delete-worktree assumptions must not run for this mode

Invariants:

- at most one `current-branch` task per canonical repository root may exist at a time, even across
  duplicate project records, symlink aliases, renderer clients, and concurrent requests
- the backend resolves the Git top-level path and reserves its canonical identity before checkout;
  renderer project-id guards are presentation feedback, not admission truth
- task creation has a client-generated operation id that the backend single-flights and replays;
  losing a browser response after checkout must not execute creation again or strand the root
- checkout of the requested branch is a backend-owned side effect, not a renderer warning
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

- branch listing and validation if current-branch tasks can target non-current branches
- base-branch detection fallback
- checkout workflow for current-branch task creation
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
- current-branch checkout sequencing
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

This repo should not keep the old renderer-owned warning path:

- previous behavior: renderer checked current branch and errored with "Please checkout X first"
- target behavior: workflow requests a backend checkout when the requested current-branch task target is not already checked out

That preserves the same user intent while moving git side effects under backend/workflow ownership.

### Branch selection

The local redesign should support a branch selection model for `current-branch` tasks.

Minimum acceptable behavior:

- choose the current project base branch explicitly or by backend detection

Target behavior:

- allow selecting the branch to work on and the base branch to diff against, with sane defaults and explicit fallback rules

This is where the spec intentionally allows a staged implementation if the final UI needs to land in smaller reviewable steps.

## Acceptance Criteria

### Data model

- no new code depends on `directMode` or `defaultDirectMode` as primary truth
- project defaults and task isolation state use explicit named fields
- empty-string base branches cannot survive across IPC or persistence boundaries

### Backend correctness

- task diff/review/merge-base logic uses explicit task/project base-branch truth
- current-branch creation can perform backend-owned checkout when required
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
