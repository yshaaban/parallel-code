# Direct Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow creating tasks that work directly on the main branch without worktree isolation.

**Architecture:** Add `directMode` flag to Task type. When set, skip Rust `create_task` IPC (no worktree/branch creation), use project root as working directory, and skip git cleanup on close. New Tauri command exposes `detect_main_branch`. UI changes in NewTaskDialog (checkbox + warning), TaskPanel (badge, hide merge/push), and Sidebar (badge).

**Tech Stack:** SolidJS (TypeScript), Rust (Tauri v2)

---

### Task 1: Add `detect_main_branch` Tauri command

**Files:**
- Modify: `src-tauri/src/git/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: Add the Tauri command**

In `src-tauri/src/git/mod.rs`, add a new public async Tauri command that wraps the existing private `detect_main_branch` function:

```rust
#[tauri::command]
pub async fn get_main_branch(project_root: String) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        detect_main_branch(&project_root)
    })
    .await
    .map_err(|e| AppError::Git(e.to_string()))?
}
```

**Step 2: Register the command**

In `src-tauri/src/lib.rs`, add `git::get_main_branch` to the `invoke_handler` list, after `git::rebase_task`.

**Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles successfully

**Step 4: Commit**

```bash
git add src-tauri/src/git/mod.rs src-tauri/src/lib.rs
git commit -m "feat(backend): expose get_main_branch Tauri command"
```

---

### Task 2: Add `directMode` to Task types and persistence

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/persistence.ts`

**Step 1: Add `directMode` to Task and PersistedTask interfaces**

In `src/store/types.ts`, add `directMode?: boolean;` to both `Task` (after `closingError?: string;`) and `PersistedTask` (after `agentDef: AgentDef | null;`):

```ts
// In Task interface:
  directMode?: boolean;

// In PersistedTask interface:
  directMode?: boolean;
```

**Step 2: Persist directMode in saveState**

In `src/store/persistence.ts`, in the `saveState` function, inside the `for (const taskId of store.taskOrder)` loop, add `directMode` to the persisted task object:

```ts
persisted.tasks[taskId] = {
  id: task.id,
  name: task.name,
  projectId: task.projectId,
  branchName: task.branchName,
  worktreePath: task.worktreePath,
  notes: task.notes,
  lastPrompt: task.lastPrompt,
  shellCount: task.shellAgentIds.length,
  agentDef: firstAgent?.def ?? null,
  directMode: task.directMode,  // <-- add this
};
```

**Step 3: Restore directMode in loadState**

In `src/store/persistence.ts`, in the `loadState` function, in the task restoration loop, add `directMode` to the constructed `Task` object:

```ts
const task: Task = {
  id: pt.id,
  name: pt.name,
  projectId: pt.projectId ?? "",
  branchName: pt.branchName,
  worktreePath: pt.worktreePath,
  agentIds: agentDef ? [agentId] : [],
  shellAgentIds,
  notes: pt.notes,
  lastPrompt: pt.lastPrompt,
  directMode: pt.directMode,  // <-- add this
};
```

**Step 4: Verify build**

Run: `cd /home/johannes/www/parallel-code/.worktrees/task/we-should-provide-the-option-to && pnpm build`
Expected: builds successfully

**Step 5: Commit**

```bash
git add src/store/types.ts src/store/persistence.ts
git commit -m "feat(store): add directMode flag to Task type and persistence"
```

---

### Task 3: Add `createDirectTask` and modify `closeTask`

**Files:**
- Modify: `src/store/tasks.ts`
- Modify: `src/store/store.ts`

**Step 1: Add createDirectTask function**

In `src/store/tasks.ts`, add a new function after `createTask`:

```ts
export async function createDirectTask(
  name: string,
  agentDef: AgentDef,
  projectId: string,
  mainBranch: string,
  initialPrompt?: string
): Promise<void> {
  const projectRoot = getProjectPath(projectId);
  if (!projectRoot) throw new Error("Project not found");

  const id = crypto.randomUUID();
  const agentId = crypto.randomUUID();

  const task: Task = {
    id,
    name,
    projectId,
    branchName: mainBranch,
    worktreePath: projectRoot,
    agentIds: [agentId],
    shellAgentIds: [],
    notes: "",
    lastPrompt: "",
    initialPrompt: initialPrompt || undefined,
    directMode: true,
  };

  const agent: Agent = {
    id: agentId,
    taskId: id,
    def: agentDef,
    resumed: false,
    status: "running",
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
  };

  setStore(
    produce((s) => {
      s.tasks[id] = task;
      s.agents[agentId] = agent;
      s.taskOrder.push(id);
      s.activeTaskId = id;
      s.activeAgentId = agentId;
      s.lastProjectId = projectId;
      s.lastAgentId = agentDef.id;
    })
  );

  markAgentSpawned(agentId);
  updateWindowTitle(name);
}
```

**Step 2: Modify closeTask to skip git operations for direct mode**

In `src/store/tasks.ts`, in `closeTask`, after the agent killing loop, add a conditional to skip `delete_task` for direct mode tasks:

Replace the section that calls `invoke("delete_task", ...)` with:

```ts
    // Kill agents
    for (const agentId of agentIds) {
      await invoke("kill_agent", { agentId }).catch(console.error);
    }
    for (const shellId of shellAgentIds) {
      await invoke("kill_agent", { agentId: shellId }).catch(console.error);
    }

    // Skip git cleanup for direct mode (no worktree/branch to remove)
    if (!task.directMode) {
      await invoke("delete_task", {
        agentIds: [...agentIds, ...shellAgentIds],
        branchName,
        deleteBranch,
        projectRoot,
      });
    }
```

**Step 3: Export createDirectTask from store barrel**

In `src/store/store.ts`, add `createDirectTask` to the tasks re-export:

```ts
export {
  createTask,
  createDirectTask,  // <-- add this
  closeTask,
  // ... rest
} from "./tasks";
```

**Step 4: Verify build**

Run: `pnpm build`
Expected: builds successfully

**Step 5: Commit**

```bash
git add src/store/tasks.ts src/store/store.ts
git commit -m "feat(store): add createDirectTask and skip git cleanup for direct mode"
```

---

### Task 4: Add helper to check for existing direct-mode task

**Files:**
- Modify: `src/store/tasks.ts`
- Modify: `src/store/store.ts`

**Step 1: Add hasDirectModeTask helper**

In `src/store/tasks.ts`, add at the bottom:

```ts
export function hasDirectModeTask(projectId: string): boolean {
  return store.taskOrder.some((taskId) => {
    const task = store.tasks[taskId];
    return task && task.projectId === projectId && task.directMode && task.closingStatus !== "removing";
  });
}
```

**Step 2: Export from store barrel**

In `src/store/store.ts`, add `hasDirectModeTask` to the tasks re-export.

**Step 3: Commit**

```bash
git add src/store/tasks.ts src/store/store.ts
git commit -m "feat(store): add hasDirectModeTask helper"
```

---

### Task 5: Update NewTaskDialog with direct mode checkbox and warning

**Files:**
- Modify: `src/components/NewTaskDialog.tsx`

**Step 1: Add imports and signal**

Add `createDirectTask`, `hasDirectModeTask` to the import from `"../store/store"`.
Add `invoke` is already imported.

Add a new signal near the top of the component:

```ts
const [directMode, setDirectMode] = createSignal(false);
```

**Step 2: Add computed for whether direct mode is available**

```ts
const directModeDisabled = () => {
  const pid = selectedProjectId();
  return pid ? hasDirectModeTask(pid) : false;
};
```

**Step 3: Reset directMode when it becomes disabled (project changes)**

Add an effect:

```ts
createEffect(() => {
  if (directModeDisabled()) setDirectMode(false);
});
```

**Step 4: Update branch/path preview**

Replace the existing branch preview `<Show>` block (lines 224-247) to be conditional on `!directMode()`:

```tsx
<Show when={!directMode()}>
  <Show when={branchPreview() && selectedProjectPath()}>
    {/* ... existing branch preview content ... */}
  </Show>
</Show>
<Show when={directMode() && selectedProjectPath()}>
  <div style={{
    "font-size": "11px",
    "font-family": "'JetBrains Mono', monospace",
    color: theme.fgSubtle,
    display: "flex",
    "flex-direction": "column",
    gap: "2px",
    padding: "4px 2px 0",
  }}>
    <span style={{ display: "flex", "align-items": "center", gap: "6px" }}>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0" }}>
        <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
      </svg>
      main branch (detected on create)
    </span>
    <span style={{ display: "flex", "align-items": "center", gap: "6px" }}>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0" }}>
        <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
      </svg>
      {selectedProjectPath()}
    </span>
  </div>
</Show>
```

**Step 5: Add checkbox + warning after the project selector section**

Insert after the project selector `</div>` (after line 369) and before the Agent section:

```tsx
{/* Direct mode toggle */}
<div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
  <label
    style={{
      display: "flex",
      "align-items": "center",
      gap: "8px",
      "font-size": "12px",
      color: directModeDisabled() ? theme.fgSubtle : theme.fg,
      cursor: directModeDisabled() ? "not-allowed" : "pointer",
      opacity: directModeDisabled() ? "0.5" : "1",
    }}
  >
    <input
      type="checkbox"
      checked={directMode()}
      disabled={directModeDisabled()}
      onChange={(e) => setDirectMode(e.currentTarget.checked)}
      style={{ "accent-color": theme.accent, cursor: "inherit" }}
    />
    Work directly on main branch
  </label>
  <Show when={directModeDisabled()}>
    <span style={{ "font-size": "11px", color: theme.fgSubtle }}>
      A direct-mode task already exists for this project
    </span>
  </Show>
  <Show when={directMode()}>
    <div style={{
      "font-size": "12px",
      color: theme.warning,
      background: "#f0a03014",
      padding: "8px 12px",
      "border-radius": "8px",
      border: "1px solid #f0a03033",
    }}>
      Changes will be made directly on the main branch without worktree isolation.
    </div>
  </Show>
</div>
```

**Step 6: Hide symlink section when directMode is checked**

Wrap the existing symlink `<Show>` block (lines 407-453) to also check `!directMode()`:

Change `<Show when={ignoredDirs().length > 0}>` to `<Show when={ignoredDirs().length > 0 && !directMode()}>`.

**Step 7: Update handleSubmit to use createDirectTask**

Replace the try block in `handleSubmit`:

```ts
try {
  if (directMode()) {
    const projectPath = getProjectPath(projectId);
    if (!projectPath) { setError("Project path not found"); return; }
    const mainBranch = await invoke<string>("get_main_branch", { projectRoot: projectPath });
    await createDirectTask(n, agent, projectId, mainBranch, p);
  } else {
    await createTask(n, agent, projectId, [...selectedDirs()], p);
  }
  toggleNewTaskDialog(false);
} catch (err) {
  setError(String(err));
}
```

**Step 8: Update the dialog subtitle**

Update the `<p>` element (line 166-168) to be dynamic:

```tsx
<p style={{ margin: "0", "font-size": "12px", color: theme.fgMuted, "line-height": "1.5" }}>
  {directMode()
    ? "The AI agent will work directly on your main branch in the project root."
    : "Creates a git branch and worktree so the AI agent can work in isolation without affecting your main branch."}
</p>
```

**Step 9: Verify build**

Run: `pnpm build`

**Step 10: Commit**

```bash
git add src/components/NewTaskDialog.tsx
git commit -m "feat(dialog): add direct mode checkbox and warning to NewTaskDialog"
```

---

### Task 6: Update TaskPanel for direct mode

**Files:**
- Modify: `src/components/TaskPanel.tsx`

**Step 1: Add direct mode badge to the branch info bar**

In the `branchInfoBar()` function, add a badge span after the branch name display. Replace the branch name `<span>` (lines 387-392) with:

```tsx
<span style={{ display: "inline-flex", "align-items": "center", gap: "4px", "margin-right": "12px" }}>
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ "flex-shrink": "0" }}>
    <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
  </svg>
  {props.task.branchName}
  <Show when={props.task.directMode}>
    <span style={{
      "font-size": "10px",
      "font-weight": "600",
      padding: "1px 6px",
      "border-radius": "4px",
      background: "#f0a03025",
      color: theme.warning,
      border: "1px solid #f0a03040",
    }}>
      direct
    </span>
  </Show>
</span>
```

**Step 2: Hide merge and push buttons for direct mode tasks**

In the `titleBar()` function, wrap the merge and push IconButtons with `<Show when={!props.task.directMode}>`:

```tsx
<div style={{ display: "flex", gap: "4px", "margin-left": "8px", "flex-shrink": "0" }}>
  <Show when={!props.task.directMode}>
    <IconButton
      icon={/* merge icon */}
      onClick={openMergeConfirm}
      title="Merge into main"
    />
    <IconButton
      icon={/* push icon */}
      onClick={() => setShowPushConfirm(true)}
      title="Push to remote"
    />
  </Show>
  <IconButton
    icon={/* close icon */}
    onClick={() => setShowCloseConfirm(true)}
    title="Close task"
  />
</div>
```

**Step 3: Update close confirm dialog for direct mode**

Update the close `ConfirmDialog` message to show simplified content for direct mode tasks. Wrap the existing message content with `<Show when={!props.task.directMode}>` and add an alternative for direct mode:

```tsx
message={
  <div>
    <Show when={props.task.directMode}>
      <p style={{ margin: "0" }}>
        Stop all agents and close this task? No branches or files will be deleted.
      </p>
    </Show>
    <Show when={!props.task.directMode}>
      {/* ... existing close confirm content ... */}
    </Show>
  </div>
}
```

Also change the confirmLabel to be dynamic:

```tsx
confirmLabel={props.task.directMode ? "Close" : "Delete"}
danger={!props.task.directMode}
```

**Step 4: Skip merge/push keyboard actions for direct mode**

In the `createEffect` that handles `pendingAction` (lines 144-153), skip merge/push for direct mode:

```ts
createEffect(() => {
  const action = store.pendingAction;
  if (!action || action.taskId !== props.task.id) return;
  clearPendingAction();
  switch (action.type) {
    case "close": setShowCloseConfirm(true); break;
    case "merge": if (!props.task.directMode) openMergeConfirm(); break;
    case "push": if (!props.task.directMode) setShowPushConfirm(true); break;
  }
});
```

**Step 5: Verify build**

Run: `pnpm build`

**Step 6: Commit**

```bash
git add src/components/TaskPanel.tsx
git commit -m "feat(panel): show direct mode badge and hide merge/push buttons"
```

---

### Task 7: Add direct mode badge to Sidebar task items

**Files:**
- Modify: `src/components/Sidebar.tsx`

**Step 1: Add a small "direct" indicator next to task name in the sidebar**

In the `Sidebar` component, find the task item rendering inside `<For each={projectTasks()}>` (around line 510). After the task name `<span>`, add a direct mode badge:

```tsx
<StatusDot status={getTaskDotStatus(taskId)} size="sm" />
<span style={{ overflow: "hidden", "text-overflow": "ellipsis" }}>{task()!.name}</span>
<Show when={task()!.directMode}>
  <span style={{
    "font-size": sf(9),
    "font-weight": "600",
    padding: "0 4px",
    "border-radius": "3px",
    background: "#f0a03020",
    color: theme.warning,
    "flex-shrink": "0",
    "line-height": "1.5",
  }}>
    direct
  </span>
</Show>
```

Do this for BOTH the project-grouped task list (around line 510) AND the orphaned task list (around line 568). Both render task items identically.

**Step 2: Verify build**

Run: `pnpm build`

**Step 3: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(sidebar): show direct mode badge on task items"
```

---

### Task 8: Manual verification

**Step 1: Run the full app**

Run: `pnpm tauri:dev`

**Step 2: Test direct mode creation**

1. Open New Task dialog
2. Select a project
3. Check "Work directly on main branch"
4. Verify: warning appears, symlink section hides, preview shows project root
5. Enter a prompt and create the task
6. Verify: task opens with agent running in project root

**Step 3: Test one-per-project constraint**

1. With a direct-mode task open, open New Task dialog again for same project
2. Verify: checkbox is disabled with explanation text

**Step 4: Test badge display**

1. Verify: sidebar shows "direct" badge next to the task name
2. Verify: task panel branch info bar shows "direct" badge
3. Verify: merge and push buttons are hidden

**Step 5: Test close behavior**

1. Click close on the direct-mode task
2. Verify: confirm dialog shows simplified message ("Stop all agents...")
3. Confirm close
4. Verify: task is removed, no git errors

**Step 6: Test persistence**

1. Create a direct-mode task
2. Close and reopen the app
3. Verify: task restores with direct mode intact (badge visible, merge/push hidden)
