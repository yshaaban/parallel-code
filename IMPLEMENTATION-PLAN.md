# Implementation Plan: Next-Gen Features

Date: March 10, 2026

This plan covers four features selected from the [Feature Parity Analysis](./FEATURE-PARITY.md):

1. **Per-Task Port Mapping & Browser Preview**
2. **Project-Level Diff & Multi-File Review Panel**
3. **Interactive Permission Approvals**
4. **Diff-to-Prompt Comments ("Review Feedback")**

---

## Feature 1: Per-Task Port Mapping & Browser Preview

### Overview

Allow users to expose ports from agent tasks and preview web apps (Vite, Next.js, Express, etc.) through the Parallel Code server. Browser-mode users can view the running app without leaving the product.

### Architecture

```
Agent PTY output → port regex detector → ExposedPort registry
                                              ↓
TaskPanel UI ← iframe/new-tab ← GET /preview/:taskId/:port/* → http-proxy → localhost:port
```

**Data model addition to `src/store/types.ts`:**

```ts
interface ExposedPort {
  port: number;
  taskId: string;
  label: string;           // e.g. "Vite dev server"
  detectedAt: number;
  manuallyAdded: boolean;
}

// Add to Task interface:
exposedPorts?: ExposedPort[];
```

### IPC Additions (`electron/ipc/channels.ts`)

```ts
ExposePort; // { taskId, port, label } → adds to registry
UnexposePort; // { taskId, port } → removes
ListExposedPorts; // { taskId } → ExposedPort[]
```

### Files to Create

| File                                  | Purpose                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `src/lib/portDetector.ts`             | Regex scanner for common "listening on port XXXX" patterns in PTY output |
| `src/components/PreviewPanel.tsx`     | Iframe-based preview panel or new-tab launcher                           |
| `src/components/ExposePortDialog.tsx` | Manual port exposure dialog                                              |

### Files to Modify

| File                           | Change                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron/ipc/channels.ts`     | Add `ExposePort`, `UnexposePort`, `ListExposedPorts`                                                                                                                         |
| `electron/ipc/handlers.ts`     | Register handlers for port IPC channels                                                                                                                                      |
| `server/main.ts`               | Add `GET /preview/:taskId/:port/*` reverse-proxy route using `http-proxy-middleware`; gate behind AUTH_TOKEN; add port registry store; broadcast `port-event` over WebSocket |
| `src/store/types.ts`           | Add `ExposedPort` interface, add `exposedPorts` to `Task`                                                                                                                    |
| `src/store/tasks.ts`           | Add `exposePort()`, `unexposePort()` actions                                                                                                                                 |
| `src/components/TaskPanel.tsx` | Add "Preview" tab/button in title bar, port indicator badge                                                                                                                  |
| `src/remote/AgentDetail.tsx`   | Add "Open Preview" button linking to `/preview/:taskId/:port/`                                                                                                               |
| `electron/ipc/pty.ts`          | Hook output listener for auto-detection (Phase 2)                                                                                                                            |

### Phase Breakdown

**MVP (Phase 1):**

- Manual "Expose Port" button in TaskPanel title bar
- `ExposePortDialog` with port number + label input
- `/preview/:taskId/:port/*` proxy route on server with auth
- Iframe preview panel or "Open in new tab" link
- WebSocket `port-event` broadcast for remote clients

**Phase 2:**

- Auto-detect ports from PTY output via `portDetector.ts`
- Toast notification: "Port 3000 detected — Preview?"
- Multiple simultaneous port previews per task

**Phase 3:**

- Mobile-optimized preview in remote app
- Port forwarding rules (e.g., map 3000→public, block 5432)
- Screenshot/snapshot of preview state

### Complexity: Large (MVP: 3-4 days, Phase 2: 2-3 days)

---

## Feature 2: Project-Level Diff & Multi-File Review Panel

### Overview

A dedicated review workspace showing all changed files across a task with unified navigation, replacing the current single-file modal workflow.

### Architecture

```
IPC.GetProjectDiff(worktreePath, mode) → { files: ChangedFile[], diffs: Record<path, FileDiffResult> }
                                              ↓
┌──────────────────────────────────────────────────────────┐
│ ReviewPanel                                               │
│ ┌─────────────┐ ┌────────────────────────┐ ┌───────────┐ │
│ │ FileNav     │ │ MonacoDiffEditor       │ │ Comments  │ │
│ │ (tree/list) │ │ (unified/split)        │ │ Sidebar   │ │
│ │             │ │                        │ │ (Feat 4)  │ │
│ │ file1.ts ◉  │ │  - old line           │ │           │ │
│ │ file2.tsx   │ │  + new line            │ │           │ │
│ │ file3.css   │ │                        │ │           │ │
│ └─────────────┘ └────────────────────────┘ └───────────┘ │
│ [← Prev] [Next →]  [Stage] [Unstage] [Copy Patch] [Send] │
└──────────────────────────────────────────────────────────┘
```

**New IPC (`electron/ipc/channels.ts`):**

```ts
GetProjectDiff; // { worktreePath, mode: 'all'|'staged'|'unstaged'|'branch' }
// → { files: ChangedFile[], totalAdded: number, totalRemoved: number }
StageFile; // { worktreePath, filePath }
UnstageFile; // { worktreePath, filePath }
```

### Files to Create

| File                               | Purpose                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `src/components/ReviewPanel.tsx`   | Main review panel with three-column layout                                        |
| `src/components/ReviewFileNav.tsx` | Left sidebar file navigator with status icons and comment badges                  |
| `src/lib/diff-parser.ts`           | **Expand** existing file: add structured hunk/line parsing (see data model below) |

**Parsed diff data model (expand `src/lib/diff-parser.ts`):**

```ts
interface ParsedDiffLine {
  key: string;
  kind: 'add' | 'delete' | 'context';
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

interface ParsedDiffHunk {
  key: string;
  header: string; // "@@ -10,5 +10,7 @@"
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedDiffLine[];
}

function parseUnifiedDiff(diffText: string): ParsedDiffHunk[];
```

### Files to Modify

| File                                  | Change                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `electron/ipc/channels.ts`            | Add `GetProjectDiff`, `StageFile`, `UnstageFile`                                                |
| `electron/ipc/git.ts`                 | Implement `getProjectDiff()` (batch `git diff` with mode flag), `stageFile()`, `unstageFile()`  |
| `electron/ipc/handlers.ts`            | Register new handlers                                                                           |
| `server/main.ts`                      | Broadcast `git-status-changed` after `StageFile`/`UnstageFile`                                  |
| `src/ipc/types.ts`                    | Add `ParsedDiffHunk`, `ParsedDiffLine` types                                                    |
| `src/store/types.ts`                  | Add `reviewMode`, `reviewSelectedFile` to store                                                 |
| `src/components/TaskPanel.tsx`        | Add "Review" tab alongside existing "Notes"/"Plan"/"Changed Files" tabs, render `<ReviewPanel>` |
| `src/components/ChangedFilesList.tsx` | Reuse as data source; add per-file comment count badge                                          |
| `src/components/DiffViewerDialog.tsx` | Keep as fallback; share diff-fetching logic with ReviewPanel                                    |

### Phase Breakdown

**MVP (Phase 1):**

- `GetProjectDiff` IPC with `all` and `branch` modes
- `ReviewPanel` with file list on left, `MonacoDiffEditor` on right
- Keyboard navigation: `↑`/`↓` in file list, `n`/`p` for next/prev file
- Unified/split toggle (reuse existing `DiffViewerDialog` toggle pattern)

**Phase 2:**

- `StageFile`/`UnstageFile` quick actions
- Staged/unstaged/branch mode switcher
- "Copy patch" and "Open in editor" buttons
- Grouped file tree (by directory) with expand/collapse

**Phase 3:**

- Integration with Feature 4 (diff comments sidebar becomes right column)
- File-level approve/reject actions
- Diff statistics summary header

### Complexity: Medium-Large (MVP: 3-5 days, Phase 2: 3-4 days)

### Dependencies

- Feature 4 (diff comments) uses this panel as its primary host

---

## Feature 3: Interactive Permission Approvals

### Overview

Surface agent permission requests (tool calls that need approval) in the UI so users can approve or reject them without relying on the terminal.

### Architecture

```
Agent PTY output → permission parser → PermissionRequest event
                                              ↓
                                    ┌─────────────────────┐
                                    │ Permission Card      │
                                    │ ┌─────────────────┐ │
                                    │ │ Tool: Edit file  │ │
                                    │ │ Path: src/app.ts │ │
                                    │ │ [Approve] [Deny] │ │
                                    │ └─────────────────┘ │
                                    └─────────────────────┘
                                              ↓
                              Approve → write "y\n" to PTY
                              Deny    → write "n\n" to PTY
```

**Key insight:** Claude Code (and similar agents) output permission prompts to the terminal and wait for `y`/`n` input. We don't need a separate permission server — we parse the terminal output and synthesize input.

**Data model (`src/store/types.ts`):**

```ts
interface PermissionRequest {
  id: string;
  agentId: string;
  taskId: string;
  tool: string;           // "Edit", "Bash", "Write", etc.
  description: string;    // human-readable summary
  arguments: string;      // tool arguments (file path, command, etc.)
  detectedAt: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  resolvedAt?: number;
  autoApproved?: boolean;
}

// Add to store:
permissionRequests: Record<string, PermissionRequest[]>;  // keyed by agentId
permissionAutoRules: PermissionAutoRule[];

interface PermissionAutoRule {
  tool: string;           // "*" for all, or specific tool name
  taskId?: string;        // scope to specific task, or global
  action: 'approve' | 'deny';
}
```

### IPC / Protocol Additions

No new IPC channels needed for MVP — permission detection happens in the output stream, and responses go through existing `WriteToAgent`.

**WebSocket additions (`server/main.ts`):**

- New server→client message type: `permission-request { agentId, request: PermissionRequest }`
- New client→server message type: `permission-response { agentId, requestId, action: 'approve'|'deny' }`

### Files to Create

| File                                   | Purpose                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/permissionParser.ts`          | Parse Claude Code permission prompts from PTY output. Detects patterns like `Do you want to allow...`, `Allow tool:`, etc. Returns structured `PermissionRequest` or null. |
| `src/components/PermissionCard.tsx`    | Inline approval card: tool icon, description, arguments preview, Approve/Deny buttons, "Always allow" checkbox                                                             |
| `src/components/PermissionHistory.tsx` | Scrollable log of past approvals/denials for a task                                                                                                                        |

### Files to Modify

| File                              | Change                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/store/types.ts`              | Add `PermissionRequest`, `PermissionAutoRule`, store fields                                                                     |
| `src/store/core.ts`               | Add permission actions: `addPermissionRequest()`, `resolvePermission()`, `addAutoRule()`                                        |
| `src/components/TaskPanel.tsx`    | Show `<PermissionCard>` inline above the prompt input when a pending permission exists; add permission count badge to title bar |
| `src/components/TerminalView.tsx` | Hook output callback to run `permissionParser` on each chunk; emit permission events to store                                   |
| `server/main.ts`                  | Handle `permission-response` WebSocket message → `writeToAgent(agentId, response)`                                              |
| `src/remote/AgentDetail.tsx`      | Show permission card in mobile UI with approve/deny buttons                                                                     |
| `src/remote/ws.ts`                | Handle `permission-request` message type                                                                                        |
| `electron/ipc/pty.ts`             | Add output hook point for permission detection (or do it purely client-side)                                                    |

### Phase Breakdown

**MVP (Phase 1):**

- `permissionParser.ts` detecting Claude Code permission prompts
- `PermissionCard` component shown inline in TaskPanel
- Approve → `writeToAgent(agentId, "y\n")`, Deny → `writeToAgent(agentId, "n\n")`
- WebSocket permission events for browser/remote mode
- Mobile approval in `AgentDetail.tsx`

**Phase 2:**

- Auto-approve rules per tool, per task
- "Always allow [tool] for this task" checkbox on approval card
- Permission history log panel
- Sound/vibration notification on mobile for pending approvals

**Phase 3:**

- Multi-agent permission overview (dashboard of all pending across tasks)
- Permission policies at project level
- Aggregate statistics (approved/denied counts)

### Complexity: Medium (MVP: 2-3 days, Phase 2: 2 days)

### Risk

- Permission prompt format varies between agent CLIs (Claude Code, Codex, Gemini). MVP should target Claude Code first, with extensible parser pattern for others.
- Edge case: if user types in terminal while permission is pending, the card and terminal could conflict. Mitigation: auto-expire permission requests after a configurable timeout.

---

## Feature 4: Diff-to-Prompt Comments ("Review Feedback")

### Overview

Let users annotate diffs with inline comments that compile into structured prompts sent back to the agent. This turns code review into an iterative feedback loop.

### Architecture

```
User clicks diff gutter → DiffCommentPopover → DiffComment saved to store
                                                        ↓
                                              ReviewPanel sidebar shows all comments
                                                        ↓
                                              "Send Feedback" → prompt compiler
                                                        ↓
Please make these changes to the code:
- In `src/foo.ts` line 42: [user comment]        → sendPrompt() → WriteToAgent
- In `src/bar.ts` lines 10-15: [user comment]
```

**Data model (`src/store/types.ts`):**

```ts
interface DiffLineAnchor {
  filePath: string;
  hunkKey: string; // stable identifier from parsed diff
  side: 'old' | 'new' | 'unified';
  startLine: number;
  endLine: number;
  diffKind: 'add' | 'delete' | 'context';
}

interface DiffComment {
  id: string;
  taskId: string;
  agentId: string;
  anchor: DiffLineAnchor;
  text: string;
  status: 'draft' | 'sent' | 'stale';
  createdAt: number;
  sentAt?: number;
}
```

**Store additions:**

```ts
// Add to AppStore:
reviewComments: Record<string, DiffComment[]>; // keyed by taskId
```

**Store actions:**

- `addReviewComment(taskId, comment)`
- `updateReviewComment(taskId, commentId, patch)`
- `removeReviewComment(taskId, commentId)`
- `markCommentsSent(taskId, commentIds)`
- `markCommentsStale(taskId, filePath)` — when diff changes after agent edits

### Prompt Compiler (`src/lib/reviewPromptCompiler.ts`)

```ts
function compileReviewPrompt(comments: DiffComment[]): string {
  // Sort by filePath, then startLine
  // Output:
  // Please make these changes to the code:
  // - In `src/foo.ts` line 42: [comment text]
  // - In `src/bar.ts` lines 10-15: [comment text]
}
```

Rules:

- One bullet per comment, sorted by file then line
- Repo-relative file paths
- Single-line: `line N`, multi-line: `lines N-M`
- Fallback to hunk header if line numbers are unavailable

### Files to Create

| File                                     | Purpose                                           |
| ---------------------------------------- | ------------------------------------------------- |
| `src/components/DiffCommentPopover.tsx`  | Inline comment input anchored to diff line        |
| `src/components/DiffCommentsSidebar.tsx` | Right-column list of all comments grouped by file |
| `src/lib/reviewPromptCompiler.ts`        | Compile comments into structured prompt text      |

### Files to Modify

| File                                  | Change                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/lib/diff-parser.ts`              | Add `parseUnifiedDiff()` producing `ParsedDiffHunk[]` (shared with Feature 2)                        |
| `src/components/MonacoDiffEditor.tsx` | Add clickable gutter decorations on changed lines; show comment markers; handle click → open popover |
| `src/components/DiffViewerDialog.tsx` | Host MVP comment UI; pass parsed hunks to editor                                                     |
| `src/components/ReviewPanel.tsx`      | (Feature 2) Include `DiffCommentsSidebar` as right column                                            |
| `src/components/TaskPanel.tsx`        | Add "Send Feedback" button; wire to `sendPrompt()` with compiled prompt                              |
| `src/store/types.ts`                  | Add `DiffComment`, `DiffLineAnchor`, `reviewComments`                                                |
| `src/store/core.ts`                   | Add comment CRUD actions                                                                             |
| `src/store/tasks.ts`                  | Add `sendReviewFeedback()` that compiles and sends                                                   |
| `src/ipc/types.ts`                    | Add parsed diff types if not already added by Feature 2                                              |

### Phase Breakdown

**MVP (Phase 1):**

- Single-file comments inside `DiffViewerDialog`
- Click changed line gutter → `DiffCommentPopover` with textarea
- Comments stored per task in store
- "Send Feedback" button compiles all draft comments and sends as one prompt
- No new IPC needed — uses existing `sendPrompt` → `WriteToAgent`

**Phase 2:**

- Full integration with Feature 2's `ReviewPanel`
- Cross-file batch comments with sidebar navigation
- Comment count badges in file navigator
- Stale-comment detection when diffs refresh after agent edits
- Jump-to-line from sidebar

**Phase 3:**

- Template prompt modes: "fix", "refactor", "follow conventions"
- Prompt preview/edit dialog before send
- Saved comment patterns / reusable feedback
- Anchor recovery when line numbers shift

### Complexity: Medium (MVP: 3-4 days, Phase 2: 1-2 weeks)

### Dependencies

- Shares `parseUnifiedDiff()` from `src/lib/diff-parser.ts` with Feature 2
- Phase 2 depends on Feature 2's `ReviewPanel` existing

---

## Unified Execution Roadmap

### Sprint 1: Foundation (Week 1)

| Day | Work                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1-2 | **Diff parser expansion** (`src/lib/diff-parser.ts`): `parseUnifiedDiff()` producing `ParsedDiffHunk[]`. Shared foundation for Features 2 and 4. |
| 2-3 | **Permission parser** (`src/lib/permissionParser.ts`): detect Claude Code permission prompts from PTY output.                                    |
| 3-4 | **Permission MVP** (Feature 3 Phase 1): `PermissionCard` in TaskPanel, WebSocket events, mobile support.                                         |
| 4-5 | **Review types and store** (`src/store/types.ts`, `src/store/core.ts`): `DiffComment`, `PermissionRequest`, review state, all CRUD actions.      |

### Sprint 2: Review Panel (Week 2)

| Day | Work                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------- |
| 1-2 | **GetProjectDiff IPC** + git operations in `electron/ipc/git.ts`                                           |
| 2-4 | **ReviewPanel MVP** (Feature 2 Phase 1): file nav + diff viewer, keyboard navigation, unified/split toggle |
| 4-5 | **ReviewPanel integration** into TaskPanel as new tab                                                      |

### Sprint 3: Diff Comments (Week 3)

| Day | Work                                            |
| --- | ----------------------------------------------- |
| 1-2 | **Gutter click + popover** in MonacoDiffEditor  |
| 2-3 | **Prompt compiler** + "Send Feedback" button    |
| 3-4 | **DiffCommentsSidebar** with cross-file view    |
| 4-5 | **Integration** with ReviewPanel (right column) |

### Sprint 4: Port Preview (Week 4)

| Day | Work                                                         |
| --- | ------------------------------------------------------------ |
| 1-2 | **Proxy route** `/preview/:taskId/:port/*` in server/main.ts |
| 2-3 | **ExposePortDialog** + PreviewPanel UI                       |
| 3-4 | **WebSocket port events** + remote/mobile preview            |
| 4-5 | **Auto-detection** from PTY output (Phase 2)                 |

### Sprint 5: Polish & Phase 2 (Week 5)

| Day | Work                                         |
| --- | -------------------------------------------- |
| 1-2 | Permission auto-rules, history log           |
| 2-3 | Stage/unstage in review panel, mode switcher |
| 3-4 | Stale-comment detection, comment badges      |
| 4-5 | Testing, integration testing, edge cases     |

### Build Order Rationale

1. **Permissions first** — smallest scope, highest safety impact, no dependencies
2. **Diff parser** — shared foundation for Features 2 and 4
3. **Review Panel** — hosts diff comments and provides the multi-file review surface
4. **Diff Comments** — builds on review panel and diff parser
5. **Port Preview** — independent feature, largest scope, can proceed in parallel

### Dependency Graph

```
Feature 3 (Permissions)  ──── independent ────

Feature 2 (Review Panel) ─── depends on ───→ diff-parser expansion
        ↑
Feature 4 (Diff Comments) ── depends on ───→ diff-parser expansion
                                              Feature 2 (Phase 2)

Feature 1 (Port Preview)  ──── independent ────
```
