# Direct Mode — Work Directly on Main Branch

## Summary

Add an option to create tasks that work directly on the project's main branch (no worktree, no feature branch). Useful for quick changes or when branch isolation isn't needed.

## Data Model

`Task` type gets a new optional field:

```ts
directMode?: boolean  // true = working directly on main branch
```

When `directMode` is true:
- `branchName` = detected main branch name (e.g. `"main"` or `"master"`)
- `worktreePath` = project root path (not a `.worktrees/` subdirectory)

## New Task Dialog

**Checkbox:** "Work directly on main branch" — below the project selector.
- Default: unchecked
- Disabled when an active direct-mode task already exists for the selected project

**When checked:**
- Branch preview and worktree path preview replaced with project root path + main branch name
- Symlink directories section hidden
- Inline yellow/amber warning appears: *"Changes will be made directly on the main branch without worktree isolation."*

**When disabled** (existing direct-mode task for project):
- Grayed out with explanation text

**On submit:**
- Skip `create_task` Rust IPC call entirely
- Create task in store with `directMode: true`, `worktreePath` = project root, `branchName` = main branch

## Task Panel

**Branch info bar:**
- Shows main branch name with a colored amber/orange badge ("main"/"direct")
- Shows project root path (clickable)
- Merge/rebase buttons hidden

**Task list sidebar:**
- Small badge indicator on the task entry for at-a-glance identification

## Closing Behavior

- Stop agent and shells only
- No git operations (no worktree removal, no branch deletion)
- Remove task from store

## Constraints

- Only one direct-mode task per project at a time
- No symlink configuration needed (working in project root)
