# Hydra Integration Plan

Date: 2026-03-07

Repositories reviewed:

- `parallel-code` at `dc9263d2af0a1fb27dc735d9cd06cb714f5cd17b`
- `Hydra` at `5eddfe0fd98264016c21b3f9f7c42b3376656a4b`

## Executive Summary

Hydra is not "just another coding CLI" in the same category as `claude`, `codex`, or `gemini`.
It is a coordinator that owns:

- an interactive operator REPL (`hydra`)
- a local HTTP daemon (`hydra-daemon`)
- long-lived headless workers (`hydra-worker`)
- its own routing logic, session state, task queue, and handoff model
- an optional concierge layer that may answer prompts instead of dispatching work
- its own persistent project state under `docs/coordination/`

Because of that, a first-class `parallel-code` integration should not be implemented as "add `hydra` to the default agent list and call it done".

The best first version is:

1. keep `parallel-code`'s existing PTY-based architecture
2. add Hydra as a first-class built-in agent
3. launch Hydra through a `parallel-code` Hydra adapter/bootstrap process, not by spawning upstream `hydra` directly
4. make `parallel-code` prompt handling and ready-state heuristics Hydra-aware

This keeps the integration aligned with the current app architecture, avoids binding `parallel-code` to unstable Hydra internals, and fixes the practical problems that a raw `hydra` PTY spawn would introduce:

- daemon port collisions
- detached daemon leaks
- prompt detection mismatches
- concierge intercepts that change the meaning of the prompt input panel
- noisy coordination artifacts in the task worktree

## 1. Hydra Overview

### 1.1 What Hydra Is

Hydra is a multi-agent orchestration system that coordinates Claude Code, Gemini CLI, and Codex CLI, plus an optional local OpenAI-compatible model. Its center of gravity is not one model session but a small orchestration stack:

- `bin/hydra-cli.mjs`: top-level CLI (`hydra`)
- `lib/hydra-operator.mjs`: interactive operator console
- `lib/orchestrator-daemon.mjs`: local daemon with HTTP API and event log
- `lib/hydra-worker.mjs`: headless workers that poll the daemon and execute tasks
- `lib/hydra-shared/agent-executor.mjs`: subprocess execution layer for Claude/Codex and direct API execution for Gemini/local
- `lib/hydra-concierge*.mjs`: conversational front-end with provider fallback
- `lib/hydra-mcp-server.mjs`: MCP server exposing Hydra tools/resources/prompts

Hydra's core value proposition is orchestration:

- prompt classification
- route selection (`single`, `tandem`, `council`)
- role-specialized agents
- daemon-backed task queue and handoffs
- model switching and recovery
- event stream, snapshots, archival, and resumable coordination state

### 1.2 Primary Invocation Surfaces

Hydra exposes four real integration surfaces.

#### A. Interactive CLI

Primary command:

```bash
hydra
```

Behavior:

- launches `lib/hydra-operator.mjs`
- auto-starts the daemon if one is not already reachable
- enters an interactive readline REPL
- uses a terminal status bar when stdout is a TTY with enough rows
- defaults to concierge chat when concierge is enabled and API keys are present

Key commands inside the REPL:

- `:help`
- `:status`
- `:mode auto|handoff|council|dispatch|smart`
- `:chat off`
- `:model`
- `:workers start|stop|restart`
- `:watch <agent>`
- `!<prompt>` to bypass concierge and force dispatch

Important detail: Hydra's operator prompt is `hydra>` or `hydra[model]>`, not the `Claude/Codex` prompt characters that `parallel-code` currently keys off of.

#### B. One-shot CLI mode

Examples:

```bash
hydra --prompt "fix the auth regression"
hydra --mode smart --prompt "refactor model loading"
node lib/hydra-operator.mjs prompt="..."
```

This is useful for batch usage, but it is not a simple request/response API:

- it still ensures the daemon exists
- it may start long-lived workers
- it may publish tasks/handoffs instead of producing one final direct answer

That makes it less suitable as a native drop-in replacement for `parallel-code`'s current "persistent terminal + direct prompt injection" flow.

#### C. Daemon HTTP API

Hydra daemon endpoints are split across `lib/daemon/read-routes.mjs` and `lib/daemon/write-routes.mjs`.

Examples:

- `GET /health`
- `GET /state`
- `GET /summary`
- `GET /prompt?agent=...`
- `GET /next?agent=...`
- `GET /events`
- `GET /events/stream`
- `POST /session/start`
- `POST /task/add`
- `POST /task/claim`
- `POST /task/update`
- `POST /handoff`
- `POST /verify`
- `POST /shutdown`

This is the most structured machine-facing surface Hydra has today.

#### D. MCP server

`lib/hydra-mcp-server.mjs` exposes tools/resources/prompts over stdio.

Important limitations for `parallel-code`:

- `hydra_ask` is only an agent-invocation tool for `gemini` or `codex`
- daemon-backed tools require the Hydra daemon
- MCP is designed for AI clients, not for `parallel-code`'s current PTY/session model

### 1.3 Inputs Hydra Accepts

Hydra takes input from multiple sources:

- prompt text
- current working directory
- `HYDRA_PROJECT` env var
- `project=...` / `--project=...` argument
- `hydra.config.json`
- `.env` / environment variables
- daemon URL and token env vars
- agent/model overrides

Important environment/config inputs:

- `HYDRA_PROJECT`
- `AI_ORCH_HOST`
- `AI_ORCH_PORT`
- `AI_ORCH_URL`
- `AI_ORCH_TOKEN`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- `HYDRA_CLAUDE_MODEL`
- `HYDRA_GEMINI_MODEL`
- `HYDRA_CODEX_MODEL`

### 1.4 Outputs Hydra Produces

Hydra produces several different output types.

#### Terminal output

- interactive operator REPL output
- spinners
- status bar footer redraws
- worker status messages
- command responses
- concierge responses

Note: concierge provider clients support streaming internally, but the interactive operator often buffers the final concierge text before printing it. PTY streaming therefore exists, but it is not always token-level.

#### Persistent project files

Under the current project root, Hydra uses `docs/coordination/` heavily.

Core files:

- `docs/coordination/AI_SYNC_STATE.json`
- `docs/coordination/AI_SYNC_LOG.md`
- `docs/coordination/AI_ORCHESTRATOR_STATUS.json`
- `docs/coordination/AI_ORCHESTRATOR_EVENTS.ndjson`
- `docs/coordination/AI_SYNC_ARCHIVE.json`
- `docs/coordination/snapshots/*`
- `docs/coordination/runs/*`
- `docs/coordination/specs/*`

Other Hydra modules also write into subdirectories of `docs/coordination/`.

This matters in `parallel-code` because the worktree itself is the task's source of truth for git status and changed-file UI.

#### Process exit codes

Hydra CLI processes use normal exit codes. The daemon client and workers also report structured success/failure states through stdout and daemon state.

### 1.5 State, Sessions, and Resumption

Hydra persists state in several layers:

1. daemon state file (`AI_SYNC_STATE.json`)
2. append-only events (`AI_ORCHESTRATOR_EVENTS.ndjson`)
3. snapshots (`docs/coordination/snapshots/`)
4. archive state (`AI_SYNC_ARCHIVE.json`)
5. optional hub sessions at `~/.claude/projects/<slug>/memory/sessions/`

Hydra supports:

- active sessions
- child sessions
- forks/spawns
- handoffs
- checkpoints
- stale-task detection
- heartbeat-based worker recovery
- dead-letter queues
- idempotency for mutating daemon requests

This is stronger than the session model of the current built-in CLIs in `parallel-code`, which mostly rely on a single long-lived process plus whatever persistence the upstream CLI already owns.

### 1.6 Models, Providers, and Auth

Hydra has two distinct model/provider layers.

#### Physical execution agents

- `claude`
- `gemini`
- `codex`
- `local`

Current behavior from the code:

- Claude headless execution uses the Claude CLI
- Codex headless execution uses `codex exec`
- Gemini headless execution bypasses the Gemini CLI and talks directly to Google's Code Assist endpoint using OAuth credentials from `~/.gemini/oauth_creds.json`
- local uses an OpenAI-compatible endpoint

#### Concierge providers

The concierge layer uses provider APIs with fallback:

- OpenAI
- Anthropic
- Google

This layer depends on API keys and is separate from Hydra's CLI-backed agent execution.

#### Current defaults from Hydra's config/code

- Claude default model: `claude-sonnet-4-6`
- Codex default model: `gpt-5.4`
- Gemini default model: `gemini-3-pro-preview` in the shipped config, with code support for newer `gemini-3.1-*` profiles

### 1.7 Streaming and Real-Time Behavior

Hydra has three different real-time channels:

1. PTY output from the operator and worker processes
2. SSE from the daemon (`/events/stream`)
3. provider-level token streaming inside concierge/provider modules

For `parallel-code`, only the PTY stream is directly usable without larger architectural work.

### 1.8 How Hydra Differs From Existing `parallel-code` Agents

Current built-in agents in `parallel-code`:

- Claude Code
- Codex CLI
- Gemini CLI
- OpenCode

These are all "single CLI session in one worktree" integrations.

Hydra differs in important ways:

| Area              | Current built-in agents                       | Hydra                                                                    |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| Process model     | one interactive CLI                           | operator + daemon + optional workers                                     |
| Prompt semantics  | prompt goes directly to model/CLI             | concierge may intercept unless bypassed                                  |
| State             | mostly process-local or upstream CLI-specific | daemon-backed event-sourced project state                                |
| File side effects | mostly source changes                         | source changes plus coordination metadata                                |
| Resume story      | CLI-specific `resume_args`                    | state restore comes from daemon files, not a dedicated resume subcommand |
| Terminal behavior | relatively simple TUI                         | owns readline prompt, scroll region, status bar, spinners                |

Hydra is therefore closer to "an orchestrator running inside a terminal" than "a single model CLI".

## 2. Current Agent Architecture in `parallel-code`

### 2.1 Default Agent Catalog

Current built-in agent definitions live in:

- `electron/ipc/agents.ts`
- `src/store/agents.ts`

Each `AgentDef` currently contains:

- `id`
- `name`
- `command`
- `args`
- `resume_args`
- `skip_permissions_args`
- `description`
- optional `available`

There is no existing concept of:

- dynamic per-task environment variables
- backend launch adapters
- agent-specific spawn orchestration
- agent-specific prompt translation rules

### 2.2 Spawn Path

Current task/agent lifecycle:

1. `src/components/NewTaskDialog.tsx`
   - user chooses project, agent, task name, prompt, direct mode, skip permissions
2. `src/store/tasks.ts`
   - `createTask()` or `createDirectTask()` creates store entries
3. `src/components/TaskPanel.tsx`
   - renders `TerminalView` for the task's active agent
4. `src/components/TerminalView.tsx`
   - invokes `IPC.SpawnAgent`
5. `electron/ipc/handlers.ts`
   - validates spawn request and calls `spawnPtyAgent(...)`
6. `electron/ipc/pty.ts`
   - resolves and validates the command
   - spawns a PTY via `node-pty`
   - forwards base64 output to the renderer

This same model works in Electron and browser mode because the browser transport mirrors the same IPC operations over HTTP + WebSocket.

### 2.3 Prompt Path

Prompt submission is intentionally minimal:

- `src/components/PromptInput.tsx`
- `src/store/tasks.ts::sendPrompt()`
- `IPC.WriteToAgent`

`sendPrompt()` writes:

1. prompt text
2. short delay
3. carriage return

This is optimized for TUI apps such as Claude Code and Codex.

### 2.4 Prompt Readiness and Idle Detection

`parallel-code` currently has frontend heuristics that infer:

- when an agent is ready for an initial auto-send
- when an agent is idle at a prompt
- when an agent is asking a blocking question

Key file:

- `src/store/taskStatus.ts`

Current prompt patterns are tailored to:

- Claude Code prompt markers
- Codex prompt marker
- shell prompts (`$`, `%`, `#`)
- `Y/n` prompts

Hydra is not currently covered.

This has three direct consequences for Hydra:

1. `parallel-code` will not reliably recognize Hydra's prompt
2. task status dots may stay "busy" even when Hydra is waiting for input
3. initial prompt auto-send may be unreliable when Hydra's status bar keeps redrawing the terminal

### 2.5 Agent Availability and Persistence

Relevant files:

- `electron/ipc/agents.ts`
- `electron/ipc/command-resolver.ts`
- `src/store/persistence.ts`

Behavior today:

- built-in agents are availability-checked by command name
- custom agents are persisted and merged with built-ins
- persisted tasks store the primary agent definition so a task can be restored after restart

This is useful for Hydra, but Hydra adds one extra requirement: the process that actually gets launched must be more than a static command string if we want safe daemon lifecycle management.

### 2.6 UI Surface Area Relevant to Hydra

Files reviewed:

- `src/components/NewTaskDialog.tsx`
- `src/components/AgentSelector.tsx`
- `src/components/PromptInput.tsx`
- `src/components/TerminalView.tsx`
- `src/components/TaskPanel.tsx`
- `src/components/SettingsDialog.tsx`
- `src/components/CustomAgentEditor.tsx`

Important current assumptions:

- the prompt panel sends work directly to a single CLI process
- "skip permissions" is just an alternate arg list
- "resume" is an alternate arg list
- agent selection UI assumes each agent is a single executable, not an orchestration environment

## 3. Integration Options

### Option A: Spawn upstream `hydra` as a PTY subprocess

#### What this means

Add Hydra as a built-in `AgentDef` with `command: "hydra"` and launch it exactly like the existing agents.

#### Advantages

- smallest code change on paper
- preserves Hydra's native operator UX
- reuses existing PTY streaming, attach, detach, resize, and kill behavior
- works in Electron and browser mode with no transport redesign

#### Disadvantages

This option is acceptable as a manual custom-agent experiment, but not as a polished first-class integration.

Major problems:

1. Daemon port collision
   - Hydra defaults to a shared daemon URL/port
   - a Hydra process in one `parallel-code` task will happily connect to an already-running daemon from another task
   - because `parallel-code` worktrees are different directories, this can connect the wrong task to the wrong coordination state

2. Detached daemon leaks
   - upstream Hydra auto-starts the daemon as a detached background process
   - killing the PTY process will not necessarily clean that daemon up
   - closing many Hydra tasks can leave orphan daemons behind

3. Prompt panel semantics are wrong by default
   - when concierge is available, Hydra interprets normal prompts as chat first
   - `parallel-code`'s prompt panel currently assumes prompts mean "send work to the agent"

4. Ready-state heuristics do not match
   - `parallel-code` does not recognize Hydra's prompt today
   - Hydra's status bar redraws the terminal continuously
   - idle and auto-send logic become noisy or inaccurate

5. Worktree noise
   - Hydra writes `docs/coordination/*` into the task worktree
   - `parallel-code` changed-files, diff, and git-watch surfaces will see this as normal task churn unless filtered

6. "Resume args" do not map
   - Hydra does not have a simple `resume --last` equivalent
   - restart/resume really means "reconnect to persisted coordination state"

#### Conclusion

Not recommended as the first-class implementation.

### Option B: Native daemon/API integration

#### What this means

Treat Hydra as a service instead of a terminal process:

- talk to the daemon HTTP API directly
- optionally consume `/events/stream`
- optionally use MCP
- render Hydra state as structured UI rather than raw terminal output

#### Advantages

- strongest long-term integration
- could expose Hydra internals directly in the `parallel-code` UI
- could map Hydra tasks/handoffs/worker activity into panels and status indicators
- avoids terminal prompt-detection issues entirely

#### Disadvantages

This is not a good first implementation.

Reasons:

1. Hydra does not expose a stable public JS SDK
   - the package exports CLIs and files, not a documented library API
   - internal module imports would be coupling to moving implementation details

2. The daemon API is only half of the system
   - the daemon manages state
   - actual work execution still depends on workers/operator logic
   - `parallel-code` would need to own worker lifecycle or embed internal Hydra worker modules

3. This would be a new architecture inside `parallel-code`
   - current app is PTY-first
   - daemon-native Hydra would require a new agent runtime model
   - browser/Electron parity would be more complex

4. MCP is not a fit for the current app model
   - MCP is useful for agent-to-agent tool access
   - it is not a replacement for `parallel-code`'s PTY task sessions

#### Conclusion

Good future direction for deep Hydra-specific UX, not the right first step.

### Option C: Custom Hydra adapter launched through the existing PTY model

#### What this means

Keep `parallel-code` PTY-based, but do not spawn upstream Hydra directly.

Instead, spawn a `parallel-code` Hydra adapter/bootstrap process that:

- runs in the task worktree
- allocates a per-task Hydra daemon URL/port
- starts and stops the Hydra daemon explicitly
- launches the Hydra operator against that daemon
- makes prompt submission from the `parallel-code` prompt panel Hydra-aware

#### Advantages

- keeps the current app architecture intact
- avoids raw daemon collisions
- prevents orphaned detached daemons
- allows Hydra-specific prompt translation without rewriting the whole app
- preserves Hydra's terminal-based UX for users who want to interact with the operator directly
- works in Electron and browser mode because the backend still exposes one PTY process

#### Disadvantages

- more work than a raw built-in agent definition
- still exposes Hydra's terminal-heavy UI inside xterm.js
- does not surface Hydra's internal workers as separate `parallel-code` panels

#### Conclusion

Recommended.

## 4. Recommended Approach

### Recommendation

Implement a hybrid of Option A and Option C:

- Hydra remains a PTY-based agent from `parallel-code`'s perspective
- but the spawned process is a `parallel-code` Hydra adapter, not raw `hydra`

### Why this is the best first implementation

It is the smallest approach that is actually correct.

It solves the hard problems without requiring a new runtime architecture:

1. Per-task daemon isolation
   - adapter can derive a deterministic daemon port from the task worktree path
   - each Hydra task gets its own daemon and coordination files

2. Clean lifecycle
   - adapter can spawn the daemon as a child it owns
   - killing the PTY kills the operator and the daemon together

3. Correct prompt semantics
   - `parallel-code` can prefix prompt-panel submissions with `!` for Hydra so work requests bypass concierge
   - direct terminal typing can still remain "native Hydra"

4. Minimal frontend churn
   - only targeted heuristic changes are required
   - no UI architecture rewrite is needed

5. Future-proofing
   - the adapter boundary becomes the place to add Hydra-specific capabilities later
   - deeper daemon-native integration can be built on top of the same Hydra-specific metadata

### Recommended MVP behavior

For the first release, Hydra in `parallel-code` should behave like this:

- appears as a built-in agent named `Hydra`
- spawns one dedicated Hydra environment per `parallel-code` task/worktree
- starts in operator mode, default route mode `auto`
- prompt panel submissions are automatically force-dispatched by prefixing `!`
- the terminal remains interactive for advanced Hydra commands
- no `resume_args`
- no `skip_permissions_args`
- availability is based on whether Hydra is installed and discoverable

### Explicit non-goals for v1

Do not try to do these in the first pass:

- map Hydra's internal workers to separate `parallel-code` columns
- expose full Hydra model management in the `parallel-code` UI
- auto-run `hydra setup` or `hydra init`
- directly import large Hydra internal modules into renderer code

## 5. Implementation Plan

### Phase 1: Add a Hydra-capable launch path in the backend

#### Files to modify

- `src/ipc/types.ts`
- `electron/ipc/agents.ts`
- `src/store/agents.ts`
- `electron/ipc/handlers.ts`
- `electron/ipc/pty.ts` or a new nearby backend module

#### Files to create

- `electron/ipc/hydra-adapter.ts` or `electron/ipc/agents/hydra-adapter.ts`

#### Work

1. Extend the backend notion of an agent definition to support a launch adapter.
   - Add an optional field such as `adapter?: 'hydra'` or `launch_adapter?: 'hydra'`.
   - Keep existing agents on the plain command path.

2. Add a built-in Hydra agent entry.
   - `id: "hydra"`
   - `name: "Hydra"`
   - availability check should verify the Hydra runtime is actually usable, not just that one top-level command exists
   - at minimum, verify `hydra` plus the daemon entrypoint used by the adapter
   - `resume_args: []`
   - `skip_permissions_args: []`
   - description should explain that Hydra is a multi-agent orchestrator, not a single model CLI

3. Implement backend adapter resolution.
   - When `adapter !== 'hydra'`, keep current spawn behavior unchanged.
   - When `adapter === 'hydra'`, resolve the launch into an internal wrapper command.

4. Implement the Hydra adapter/bootstrap process.
   - Run in the task worktree.
   - Determine the Hydra project root from `cwd`.
   - Derive a stable per-worktree daemon port from the absolute worktree path.
   - Probe for collisions and increment if necessary.
   - Start `hydra-daemon` or the equivalent daemon entrypoint as a managed child process.
   - Wait for `/health`.
   - Launch `hydra`/`hydra-operator` against `url=http://127.0.0.1:<port>`.
   - Pass `welcome=false` to reduce startup noise.
   - Trap process exit and signals, then stop the daemon cleanly with `/shutdown` or a final kill fallback.

5. Do not rely on Hydra's own detached daemon auto-start.
   - The adapter should own the daemon lifecycle explicitly.
   - This is required to avoid orphaned daemons and cross-task state bleed.

### Phase 2: Make prompt handling Hydra-aware

#### Files to modify

- `src/store/tasks.ts`
- `src/components/PromptInput.tsx`
- `src/store/taskStatus.ts`

#### Work

1. Add Hydra-specific prompt translation for the prompt panel.
   - When the task's primary agent is Hydra, prompt-panel submissions should be transformed to force dispatch:
     - input panel text `fix auth bug`
     - terminal write `!fix auth bug`
   - Apply the same rule to `initialPrompt` auto-send and manual prompt sends.

2. Add Hydra prompt recognition in `taskStatus.ts`.
   - Recognize `hydra>` and `hydra[model]>` style prompts after ANSI stripping.
   - Add Hydra to the "agent ready" path used for initial prompt auto-send.

3. Adjust idle heuristics to tolerate Hydra's footer redraws.
   - Hydra's status bar can keep the PTY "active" even when the operator is ready.
   - The heuristics should check for a Hydra prompt within the tail buffer, not just the final shell-like line.

4. Keep the direct terminal fully native.
   - If the user types into the Hydra terminal directly, do not rewrite what they type.
   - Only the external prompt panel should apply the `!` convention.

### Phase 3: UI and configuration polish

#### Files to modify

- `src/components/NewTaskDialog.tsx`
- `src/components/AgentSelector.tsx`
- `src/components/SettingsDialog.tsx`
- `src/store/types.ts`
- `src/store/core.ts`
- `src/store/persistence.ts`

#### Work

1. Surface Hydra as a first-class agent in the selector.
   - Add explanatory copy that this is a coordinator that can internally route Claude/Gemini/Codex.

2. Hide the skip-permissions checkbox for Hydra.
   - Hydra's permission model is not a single "add these args" toggle.
   - For MVP, `skip_permissions_args` should stay empty.

3. Add optional Hydra-specific settings if desired.
   - `hydraCommand` override path if `hydra` is not on PATH
   - `hydraForceDispatchFromPromptPanel` default `true`
   - `hydraStartupMode` default `auto`

4. Persist any Hydra-specific settings alongside other app settings.

### Phase 4: Reduce worktree noise from Hydra coordination artifacts

#### Files to inspect/modify

- `electron/ipc/git.ts`
- changed-file UI components under `src/components/*`

#### Work

Hydra writes coordination state under `docs/coordination/` inside the task worktree. That is likely to show up in:

- changed files
- diff lists
- git watchers
- merge/readiness UI

Recommended MVP handling:

- do not rewrite git history or mutate the repo automatically
- add a UI-level default filter for Hydra coordination artifacts, such as:
  - `docs/coordination/**`
- keep a way to reveal them if the user wants to inspect them

This is safer than hard-removing them from backend git queries for all tasks.

### Phase 5: Restart/resume behavior

#### Files to modify

- `src/components/TaskPanel.tsx`
- possibly `src/store/agents.ts`

#### Work

Hydra does not need special resume args if the adapter uses the worktree as the project root and the daemon state is file-backed.

Recommended behavior:

- regular restart is the primary action
- if `parallel-code` wants a separate "resume" affordance, it should map to the same adapter launch path
- do not model Hydra resume as a CLI argument list

### Phase 6: Packaging and runtime considerations

#### Files to inspect

- Electron build config and packaging config
- any place internal backend scripts are bundled

#### Work

Make sure the Hydra adapter entrypoint is available in:

- development
- Electron packaged app
- browser/server mode

Avoid a design that depends on a repo-relative script path only working in development.

## 6. Configuration and UI Changes

### 6.1 Agent Definition Changes

Hydra needs more than the current `command + args` shape if the implementation is going to be robust.

Recommended additions to the agent definition model:

- `adapter?: 'hydra'`
- optional future `settingsKey?: 'hydra'`

Existing fields can remain:

- `command`: upstream Hydra executable used for availability checks
- `args`: probably empty in user-facing config because the adapter owns actual launch arguments
- `resume_args`: empty
- `skip_permissions_args`: empty

### 6.2 New Settings Worth Adding

Minimal useful settings:

- Hydra command override
  - useful if Hydra is installed in a non-standard location

- Force-dispatch prompt panel submissions
  - default `true`
  - means prompt-panel sends use `!` automatically

- Startup mode
  - default `auto`
  - advanced users may want `dispatch`, `smart`, or `council`

Potential later settings:

- hide/show Hydra coordination files
- allow concierge passthrough from prompt panel
- worker permission mode mapping

### 6.3 New UI Copy

Suggested agent description:

> Hydra orchestrates Claude, Gemini, and Codex behind one operator console with its own daemon, workers, and routing logic.

Suggested tooltip/help text:

> Prompt-panel messages are force-dispatched to Hydra. Type directly in the terminal if you want native Hydra chat/commands.

### 6.4 Settings That Should Not Be Automatic

Do not automatically run:

- `hydra setup`
- `hydra init`

Reasons:

- both mutate user-level or repo-level state
- first-class agent support should not silently alter external AI CLI configs or project instruction files

## 7. Testing Strategy

### 7.1 Unit Tests

Add unit tests for the Hydra adapter/backend behavior.

Targets:

- port derivation from worktree path
- collision resolution
- correct daemon/operator launch args
- shutdown path kills both operator and daemon
- availability logic

Use a mocked Hydra executable where possible instead of requiring a real install.

### 7.2 PTY Integration Tests

Add backend integration tests similar in spirit to the existing PTY tests.

Scenarios:

1. spawn Hydra adapter
2. verify PTY stays attached to the adapter process
3. verify adapter launches managed child processes
4. verify `KillAgent` stops the adapter and the daemon
5. verify restarting the same task reuses the same worktree-backed state

### 7.3 Frontend Heuristic Tests

Add tests around:

- Hydra prompt detection in `taskStatus.ts`
- Hydra initial auto-send behavior
- prompt-panel `!` prefixing
- no regression for Claude/Codex/Gemini prompt handling

Important edge case:

- Hydra footer/status-bar redraws should not permanently keep the task marked busy if the prompt is available.

### 7.4 Real-world Manual Smoke Tests

Run these with a real Hydra install.

#### Core lifecycle

1. create a new `parallel-code` task with Hydra
2. verify the terminal launches
3. verify initial prompt auto-sends
4. verify prompt-panel submissions dispatch work
5. verify direct terminal commands still work
6. close task and verify no daemon remains running for that task

#### Concurrency

1. create two Hydra tasks against the same repo in different `parallel-code` worktrees
2. verify each gets its own daemon URL/port
3. verify their `docs/coordination/` states remain isolated

#### Restart

1. restart a Hydra task
2. verify it reconnects to worktree-backed Hydra state instead of starting from a blank environment

#### Browser mode

1. run the same Hydra task flow through the browser/server transport
2. verify terminal output, prompt sends, and task close semantics remain correct

### 7.5 Negative Tests

Test failure modes explicitly:

- Hydra not installed
- daemon port already in use
- daemon fails health check
- operator exits early
- worktree path deleted while daemon is starting
- prompt panel send while Hydra is still booting

## 8. Risks and Mitigations

### Risk 1: Cross-task daemon collisions

Problem:

- upstream Hydra uses a shared default daemon port
- multiple Hydra tasks in `parallel-code` could attach to the wrong daemon

Mitigation:

- adapter-managed per-task daemon URLs
- never spawn upstream Hydra directly without that isolation

### Risk 2: Orphaned daemon processes

Problem:

- raw Hydra auto-starts detached daemons
- task close would not necessarily clean them up

Mitigation:

- adapter owns daemon lifecycle
- on PTY kill, stop daemon explicitly

### Risk 3: Concierge intercept changes prompt semantics

Problem:

- users expect prompt-panel messages to start work
- Hydra may treat them as chat unless prefixed with `!`

Mitigation:

- prompt panel prefixes `!` for Hydra
- document that direct terminal typing remains native Hydra behavior

### Risk 4: Prompt readiness heuristics break

Problem:

- `parallel-code` currently recognizes Claude/Codex/shell prompts, not Hydra
- Hydra footer redraws add noise

Mitigation:

- Hydra-specific prompt regexes
- tail-buffer prompt detection rather than only "last visible line"
- dedicated tests for redraw noise

### Risk 5: `docs/coordination/` pollutes the task's git UI

Problem:

- Hydra writes many coordination artifacts into the task worktree

Mitigation:

- UI-level default filter for Hydra coordination files
- leave reveal capability for advanced debugging

### Risk 6: Nested worktree/orchestration confusion

Problem:

- `parallel-code` already isolates work via git worktrees
- Hydra also has optional worktree features and its own task orchestration

Mitigation:

- run Hydra inside the already-isolated `parallel-code` worktree
- do not auto-enable Hydra worktree management
- optionally warn if Hydra's own `worktrees.enabled` is true

### Risk 7: Global Hydra config influences task behavior

Problem:

- Hydra reads a global runtime config
- users may have custom concierge, routing, worktree, or model settings

Mitigation:

- document that `parallel-code` respects the user's Hydra config by default
- keep MVP settings minimal and avoid rewriting Hydra's global config automatically

### Risk 8: Terminal UX mismatch remains visible

Problem:

- Hydra is terminal-heavy and owns readline/status-bar behavior

Mitigation:

- accept this for MVP
- keep the prompt panel useful through Hydra-specific translation
- reserve daemon-native Hydra dashboards for a future phase

## 9. Recommended Delivery Phases

### Phase 1

- Add Hydra built-in agent metadata
- Add Hydra adapter/bootstrap path
- Add Hydra prompt-panel force-dispatch behavior
- Add Hydra prompt detection

Outcome:

- usable first-class Hydra agent
- safe concurrent tasks
- no daemon leaks

### Phase 2

- add settings polish
- add worktree artifact filtering
- tighten restart/resume UX

Outcome:

- good day-to-day usability

### Phase 3

- optionally expose Hydra daemon state in the UI
- optionally add a Hydra-specific side panel for workers/tasks/events

Outcome:

- deeper native integration without losing the PTY path

## 10. Final Recommendation

Implement Hydra as a PTY-launched first-class agent through a `parallel-code` Hydra adapter, not as a raw `hydra` executable entry and not as a daemon-native rewrite.

This gives `parallel-code`:

- the smallest change set that is operationally safe
- compatibility with the current PTY-based architecture
- correct daemon lifecycle management
- predictable prompt-panel behavior
- room to grow into a deeper Hydra-specific integration later

It also respects what Hydra actually is: a coordinator with its own runtime, not a thin single-process coding CLI.

## 11. File-by-file Change Map

This is the most direct mapping from the research to the `parallel-code` codebase.

### Backend and shared types

- `src/ipc/types.ts`
  - add the optional Hydra adapter metadata to `AgentDef`
  - keep the existing shape backward-compatible for current agents and persisted custom agents

- `electron/ipc/agents.ts`
  - add the built-in Hydra catalog entry
  - update availability detection so it validates the Hydra runtime surface the adapter will rely on

- `src/store/agents.ts`
  - add the same built-in Hydra fallback definition used when IPC agent loading fails

- `electron/ipc/handlers.ts`
  - resolve Hydra adapter launches before calling the generic PTY spawn path
  - keep all non-Hydra agents on the current generic flow

- `electron/ipc/pty.ts`
  - either leave generic PTY behavior untouched and spawn the adapter as a normal command
  - or add a small helper hook if the adapter resolution is easiest to express here
  - do not add Hydra-specific logic that should live in the adapter itself

- `electron/ipc/hydra-adapter.ts` or `electron/ipc/agents/hydra-adapter.ts`
  - new file
  - own the Hydra daemon lifecycle
  - derive per-task port
  - wait for health
  - launch the operator with inherited stdio
  - shut everything down on exit/signals

### Prompt handling and terminal heuristics

- `src/store/tasks.ts`
  - make prompt-panel sends Hydra-aware
  - prefix `!` when sending to Hydra from the external prompt panel

- `src/components/PromptInput.tsx`
  - make the initial auto-send path use the same Hydra translation logic
  - keep terminal-native typing untouched

- `src/store/taskStatus.ts`
  - add Hydra prompt recognition
  - make idle/ready detection resilient to Hydra's scroll-region footer redraws
  - add tests for tail-buffer matches with Hydra prompt text present

### UI and persistence

- `src/components/NewTaskDialog.tsx`
  - surface Hydra in the agent picker
  - ensure skip-permissions UX does not appear for Hydra

- `src/components/AgentSelector.tsx`
  - display Hydra as a built-in first-class option with accurate copy

- `src/components/SettingsDialog.tsx`
  - add any Hydra-specific settings that are accepted for MVP

- `src/store/types.ts`
  - persist any new Hydra settings fields

- `src/store/core.ts`
  - initialize new Hydra-related store defaults if settings are added

- `src/store/persistence.ts`
  - save/load any Hydra-specific settings
  - make sure persisted Hydra tasks restore cleanly

- `src/components/TaskPanel.tsx`
  - verify restart behavior for Hydra is sensible when `resume_args` are empty
  - optionally relabel restart/resume affordances if Hydra should not show a separate resume action

### Git and changed-file UX

- `electron/ipc/git.ts`
  - inspect whether Hydra coordination artifacts should be filtered at the backend layer
  - default recommendation is still UI-level filtering, not backend deletion

- changed-file and diff UI components under `src/components/*`
  - add a Hydra-aware default filter or affordance for `docs/coordination/**`

### Tests

- PTY/backend tests near `electron/ipc/*.test.ts`
  - adapter lifecycle
  - kill/shutdown semantics
  - spawn correctness

- frontend/store tests near the task status and prompt handling code
  - Hydra prompt regexes
  - force-dispatch prompt translation
  - no regressions for current agents
