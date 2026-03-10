# Feature Parity Analysis: Parallel Code vs AgentRove

Date: March 10, 2026

## Scope

This report compares AgentRove (`/tmp/agentrove`) against Parallel Code (`/home/yrsh/parallel-code`) to identify high-priority features that Parallel Code should consider adding.

Reviewed areas:

- AgentRove: `README.md`, backend sandbox/workspace/config/permission services, and frontend diff/preview/browser/mobile/file-tree views
- Parallel Code: `README.md`, `server/main.ts`, key UI in `src/components/`, and the browser/mobile companion in `src/remote/`

No code was changed outside this report.

## Executive Summary

Top 5 features Parallel Code should consider adding:

1. **Per-task port mapping and browser preview**
   AgentRove can detect listening ports inside a workspace sandbox, generate preview URLs, and render them in web/mobile preview panels. Parallel Code exposes only its own app UI in browser mode; it does not natively expose app servers started inside agent terminals.
   Priority: `Critical`
   Difficulty: `Large`

2. **Project-level diff and review workspace**
   AgentRove has a dedicated repo-wide diff view with staged/unstaged/branch/all modes plus a first-class file tree. Parallel Code has a strong changed-files list and single-file diff modal, but no multi-file review surface.
   Priority: `High`
   Difficulty: `Medium`

3. **Interactive permissions workflow**
   AgentRove treats tool permission approvals as a product feature with backend routing and UI affordances. Parallel Code mostly relies on CLI flags and task configuration such as skip-permissions behavior.
   Priority: `Critical`
   Difficulty: `Medium`

4. **Embedded browser, IDE, and VNC-style task surfaces**
   AgentRove gives users a unified workbench: terminal, file tree, diffs, browser preview, mobile preview, IDE, and VNC/browser control in one product. Parallel Code is still primarily terminal-centric.
   Priority: `High`
   Difficulty: `Large`

5. **Workspace/sandbox abstraction with security and resource policy**
   AgentRove has a stronger notion of workspace ownership, sandbox provider selection, preview restrictions, and resource-aware backend orchestration. Parallel Code has excellent per-task worktrees, but not the same execution abstraction.
   Priority: `Medium`
   Difficulty: `Large`

Bottom line:

- The biggest user-facing gap is **web app preview from browser mode**.
- The biggest workflow gap is **repo-level review across many changed files**.
- The biggest safety gap is **interactive permission approvals**.
- Parallel Code is already ahead in **multi-agent worktree isolation**, **mobile remote monitoring**, and **terminal transport quality**.

## Detailed Feature Comparison

| Feature area                        | What AgentRove has                                                                                                                      | What Parallel Code has                                                                                                                     | Gap assessment                                                                      | Priority | Difficulty |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------- | ---------- |
| Browser port mapping / forwarding   | Sandbox APIs expose preview links, browser/VNC/IDE URLs, and can route previews through `/sandbox/{id}/{port}` or direct host bindings. | Browser mode serves Parallel Code itself over port `3000`, plus `/remote` and `/ws`. No per-task preview proxy for apps started by agents. | Major gap. This is the clearest feature missing for browser-first coding workflows. | Critical | Large      |
| Web preview / mobile preview        | Dedicated web preview and mobile preview panels, including port selection and mobile/Expo-oriented UX.                                  | Remote mobile app monitors agents and terminals well, but it is not an app-preview surface for the code being built.                       | Major gap. Parallel Code helps you watch the agent, not the app the agent started.  | High     | Medium     |
| Embedded browser / VNC / IDE        | First-class embedded browser, VNC client, and IDE view tied to the workspace sandbox.                                                   | Terminal, notes, plans, changed files, and dialogs. No embedded IDE/browser/VNC workbench.                                                 | Large product gap, especially for end-to-end build/test/debug loops.                | High     | Large      |
| Project-level diff viewer           | Repo-wide diff endpoint with `all`, `staged`, `unstaged`, and `branch` modes. Unified and split rendering in a dedicated view.          | `ChangedFilesList` plus `DiffViewerDialog` for single-file inspection. Good file-level diff, no repo-wide review mode.                     | High-value workflow gap.                                                            | High     | Medium     |
| File tree / project browser         | First-class file tree with search, refresh, and download affordances.                                                                   | No first-class repository tree or code-review browser was found in the reviewed UI.                                                        | Important complement to diff/review and IDE-style workflows.                        | High     | Medium     |
| Permission approval workflow        | Backend permission server plus frontend approval UI for tool actions.                                                                   | Task creation and agent config can relax permissions, but there is no equivalent interactive approval center.                              | Safety and governance gap.                                                          | Critical | Medium     |
| Workspace / sandbox model           | Workspace owns a sandbox, provider, source type, preview state, and ownership checks.                                                   | Strong task/worktree model, but execution remains mostly host-local and task-centric.                                                      | Foundation gap rather than a pure UI gap.                                           | Medium   | Large      |
| Output packaging / workspace export | Can download a workspace as a zip and expose IDE/VNC/browser URLs from the backend.                                                     | Strong terminal output streaming and git workflows, but no comparable workspace export path surfaced in the reviewed areas.                | Useful but not urgent.                                                              | Low      | Small      |
| Security boundary around previews   | Preview exposure is tied to sandbox ownership and excluded-port rules.                                                                  | Auth token protects the app and WebSocket, but there is no task-level preview exposure feature to secure yet.                              | Important once preview proxying is added.                                           | High     | Large      |
| Remote/mobile agent monitoring      | Has preview-oriented mobile support, but not the same browser-based agent-control product surface.                                      | Strong remote PWA with QR onboarding, agent list, live scrollback, reconnect logic, and terminal control.                                  | Parallel Code is ahead.                                                             | Low      | N/A        |
| Multi-agent branch isolation        | Workspace-based sandbox model, but not the same git-worktree-per-agent flow.                                                            | Strong branch/worktree isolation, merge flow, and arena comparison UX.                                                                     | Parallel Code is ahead.                                                             | Low      | N/A        |
| Terminal transport quality          | Solid integrated product, but terminal transport was not its standout differentiator.                                                   | Mature browser transport with channel buffering, reconnect behavior, scrollback handling, and WebGL pooling.                               | Parallel Code is ahead.                                                             | Low      | N/A        |

## Deep Dives on High-Priority Gaps

### 1. Port Mapping / Forwarding for Browser Mode

#### What AgentRove has

- Backend endpoints for preview links, browser start/stop, IDE URL, and VNC URL
- Sandbox provider logic that discovers listening ports and can rewrite previews to a stable app path
- Frontend panels for web preview, mobile preview, browser view, and VNC access

Relevant implementation areas:

- AgentRove backend: `backend/app/api/endpoints/sandbox.py`
- AgentRove sandbox logic: `backend/app/services/sandbox.py`
- AgentRove provider logic: `backend/app/services/sandbox_providers/docker_provider.py`
- AgentRove preview/browser UI: `frontend/src/components/sandbox/web-preview/*`, `frontend/src/components/views/BrowserView.tsx`, `frontend/src/components/sandbox/mobile-preview/*`

#### What Parallel Code has today

- `server/main.ts` runs the browser server for Parallel Code itself
- `/remote` exposes the mobile companion for agent monitoring
- `/ws` streams terminal and task events
- No built-in concept of "app preview for a port opened by this task"

Implication:

- If an agent starts a Vite, Next.js, or Expo dev server inside a task, Parallel Code does not currently give browser-mode users a native way to open that app through the product.

#### Why this matters

- It blocks a core browser-mode workflow: "ask the agent to run the app, then inspect the result without leaving the product"
- It makes Parallel Code less compelling for frontend and full-stack tasks than it is for pure CLI workflows

#### Recommended implementation path

1. Start with explicit port exposure, not automatic exposure of arbitrary localhost ports.
2. Add task-scoped exposed-port state and IPC methods in the existing Node/Electron layer.
3. Add a reverse-proxy route such as `/preview/:taskId/:port/*` on the existing server.
4. Gate previews behind the existing auth token and a task-owned allowlist.
5. Add a preview panel in `TaskPanel` or as a sibling split view.
6. Add mobile-friendly open/share actions once the desktop/browser flow is stable.

Implementation notes for Parallel Code:

- Reuse the current browser server in `server/main.ts` rather than adding a second service.
- Reuse task identity and panel layout patterns from `src/components/TaskPanel.tsx`.
- Treat automatic port discovery as a second phase. The first phase can be user-driven and safer.

Primary risk:

- Parallel Code runs tasks on the host, not in a strict sandbox. Full AgentRove-style automatic preview parity is harder because the app must avoid proxying unrelated localhost services.

### 2. Rich Diff / Multi-File Project-Level Review

#### What AgentRove has

- Repo-wide diff retrieval with multiple modes
- Dedicated diff view with unified/split rendering
- File tree and review-adjacent navigation in the same workbench

Relevant implementation areas:

- AgentRove diff endpoint: `backend/app/api/endpoints/sandbox.py`
- AgentRove diff view: `frontend/src/components/views/DiffView.tsx`
- AgentRove file tree: `frontend/src/components/editor/file-tree/*`

#### What Parallel Code has today

- `ChangedFilesList` gives a strong per-task list of modified files
- `DiffViewerDialog` renders a solid single-file diff experience
- Arena and merge flows reuse the same changed-files and per-file diff patterns
- No dedicated repository-wide diff screen, no staged/unstaged/branch review modes, and no first-class project browser

Relevant implementation areas:

- Parallel Code changed files: `src/components/ChangedFilesList.tsx`
- Parallel Code per-file diff: `src/components/DiffViewerDialog.tsx`
- Parallel Code task integration: `src/components/TaskPanel.tsx`

#### Why this matters

- Parallel Code is already strong at multi-agent code generation.
- That makes review quality more important, not less.
- Reviewing a large task file-by-file is slower and weaker than reviewing the whole patch as a cohesive change set.

#### Recommended implementation path

1. Add a new IPC operation for repo-wide diff retrieval with modes such as `all`, `staged`, `unstaged`, and `branch`.
2. Build a dedicated review panel, not just a larger modal.
3. Keep the existing single-file diff modal as a drill-down view.
4. Add a file tree or grouped patch navigator on the left side of the review panel.
5. Add quick actions such as "open all changed files", "jump to next file", and "copy patch".

This is a good near-term feature because:

- The data model is close to existing git support.
- The UX can reuse existing diff rendering patterns.
- It strengthens Parallel Code's existing multi-agent and merge workflows immediately.

### 3. Interactive Permissions and Approval UX

#### What AgentRove has

- A dedicated permission server and API flow
- Frontend components/hooks that surface permission requests inline
- A clearer governance model for high-autonomy tool use

Relevant implementation areas:

- AgentRove permission backend: `backend/permission_server.py`
- AgentRove permission UI/hooks: `frontend/src/components/...ToolPermissionInline...`, `frontend/src/hooks/...permission...`

#### What Parallel Code has today

- Task-level config and CLI behavior can make permissions more permissive
- The reviewed UI does not expose a comparable approval/reject workflow for live tool requests

Relevant implementation areas:

- Parallel Code task setup/config: `src/components/NewTaskDialog.tsx`
- Parallel Code agent setup: `electron/ipc/agents.ts`

#### Why this matters

- As soon as Parallel Code expands previews, embedded tools, or broader automation, permission handling becomes a product requirement rather than a backend detail.
- This is especially important for enterprise use or any environment where the browser server is shared across devices.

#### Recommended implementation path

1. Add a permission-broker layer in the Electron/main-process or server IPC layer.
2. Surface pending approvals over the existing WebSocket stream.
3. Show approval cards inline in the relevant task panel.
4. Record approval history so users can inspect what was allowed and when.

This feature is lower engineering cost than full preview parity and materially improves safety.

### 4. Embedded Browser / IDE / VNC Workbench

#### What AgentRove has

- Browser controls tied to the workspace sandbox
- Embedded IDE access
- VNC/browser surfaces for richer debugging and app inspection
- A product shape that looks like a full AI development workbench

Relevant implementation areas:

- AgentRove browser view: `frontend/src/components/views/BrowserView.tsx`
- AgentRove VNC client: `frontend/src/components/sandbox/vnc-browser/VNCClient.tsx`
- AgentRove IDE handling: workspace/sandbox services and IDE view components

#### What Parallel Code has today

- Terminal-centric task panels
- Notes, plans, merge flow, changed files, and remote monitoring
- No embedded IDE/browser/VNC layer attached to a task or workspace

#### Why this matters

- This is the difference between "agent terminal manager" and "full development cockpit"
- For UI-heavy tasks, the ability to code, preview, and inspect in one window is a major differentiator

#### Recommended implementation path

- Do not attempt full parity first.
- Phase 1: port preview panel
- Phase 2: project review panel and file tree
- Phase 3: optional embedded editor surface
- Phase 4: VNC/browser-style control only if a stronger sandbox model exists

Reason:

- Without stronger execution isolation, embedded browser/VNC parity is expensive and easy to get wrong.

### 5. Workspace / Sandbox Abstraction

#### What AgentRove has

- Workspaces as first-class entities
- Workspace ownership and sandbox ownership checks
- Configurable sandbox providers
- Preview routing and resource-aware backend orchestration

Relevant implementation areas:

- AgentRove workspace service: `backend/app/services/workspace.py`
- AgentRove config: `backend/app/core/config.py`
- AgentRove dependency/ownership checks: `backend/app/core/deps.py`

#### What Parallel Code has today

- Strong task/worktree model
- Good local-first ergonomics
- Browser server and Electron IPC share the same backend surface
- No equivalent provider abstraction for "where this task runs" or "how its previews are exposed"

#### Why this matters

- Some of AgentRove's best features are not isolated UI widgets. They come from a stronger execution model.
- Preview URLs, IDE embedding, VNC access, output export, and ownership checks all become easier once execution is modeled explicitly.

#### Recommended implementation path

- Do not replace the task/worktree model; build on it.
- Add a lightweight execution profile per task or per project.
- Execution profile examples: `local host`, `managed dev server`, `future container/sandbox`.
- Use that layer to decide which ports may be exposed.
- Use that layer to decide whether IDE/browser embedding is allowed.
- Use that layer to decide which permissions require approval.
- Use that layer to decide what cleanup and resource policies apply.

This is foundational work. It is valuable, but it should follow the higher-ROI UX features unless Parallel Code plans a broader platform shift.

## Features Where Parallel Code Is Ahead

### 1. Multi-Agent Git Worktrees and Merge Flow

Parallel Code has a stronger "one task, one branch/worktree" operating model than AgentRove.

Why it matters:

- Cleaner isolation between agent attempts
- Easier side-by-side comparison
- Better fit for code-generation tournaments and controlled merges

Relevant areas:

- `src/store/tasks.ts`
- `src/components/NewTaskDialog.tsx`
- `src/components/TaskPanel.tsx`
- `src/components/MergeDialog.tsx`
- `src/arena/*`

### 2. Remote Mobile Monitoring and Control

Parallel Code's browser/mobile companion is more mature for supervising agents from a phone or second device.

Strengths:

- QR onboarding
- persistent auth token flow
- agent list and detail views
- live scrollback and reconnect behavior
- task control from mobile

Relevant areas:

- `server/main.ts`
- `src/components/ConnectPhoneModal.tsx`
- `src/remote/*`

### 3. Terminal Streaming Reliability and Performance

Parallel Code appears more optimized for long-lived remote terminal usage.

Strengths:

- channel buffering and queueing
- reconnect and heartbeat behavior
- scrollback management
- WebGL context pooling

Relevant areas:

- `src/lib/ipc.ts`
- `src/components/TerminalView.tsx`
- `src/lib/webglPool.ts`

### 4. Local-First Simplicity

AgentRove has a richer workspace/sandbox model, but it also carries more backend complexity. Parallel Code is simpler to run locally and already has a strong remote mode without requiring the same server stack.

That simplicity is a competitive advantage and should be preserved while adding parity features.

## Suggested Sequencing

Recommended order for Parallel Code:

1. **Project-level diff/review panel**
   Fastest high-value win. Builds directly on existing git and diff infrastructure.

2. **Interactive permissions**
   Important safety upgrade before expanding execution scope.

3. **Task-scoped preview proxy**
   Start with explicit port exposure and authenticated preview routing.

4. **File tree / project browser**
   Pairs naturally with the review panel and preview surface.

5. **Execution profile / sandbox abstraction**
   Foundation for safer previewing and richer embedded tooling.

6. **Embedded IDE/browser/VNC**
   Pursue only after the preview and execution model are stable.

## Final Recommendation

If the goal is to close the most obvious competitive gaps without losing Parallel Code's strengths, the best near-term plan is:

- ship a **repo-level review workspace**
- add **interactive permission approvals**
- add **task-scoped app preview URLs**

Those three changes would address the most visible shortcomings versus AgentRove while preserving what Parallel Code already does better: multi-agent branch isolation, remote supervision, and strong terminal ergonomics.
