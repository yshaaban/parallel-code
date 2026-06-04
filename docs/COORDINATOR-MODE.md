# Coordinator Mode

Coordinator mode is the browser-server implementation of background task orchestration. It lets a
user start one visible coordinator agent and give that agent a backend credential for spawning,
prompting, and landing hidden subtasks.

This is not a port of upstream MCP coordinator code. The local design keeps orchestration backend
owned, replayable, and browser-first.

## Support Boundary

Coordinator mode is available from the browser server runtime. Electron-only runs do not expose the
tool-call gateway, so the New Task dialog keeps the option unavailable there.

Coordinator mode currently requires host-run agents. Docker runner profiles are rejected because
the credential file and loopback tool URL are host resources; container-safe credential mounting and
network policy need a separate design.

## Runtime Shape

The backend owns coordinator runs in `electron/coordinator/*`.

- `runtime.ts` owns replayable run, subtask, prompt, landing, workflow, diagnostics, and
  idempotency state.
- `service.ts` owns persistence, credential files, token indexes, activity hints, and cleanup.
- `tool-gateway.ts` owns authorized agent tool execution, renderer action execution, and prompt
  delivery.
- `handlers.ts` exposes typed IPC handlers.

Browser mode exposes `POST /api/coordinator/tool-call`. The browser token is not the authority for
that endpoint; each tool call must include the per-task coordinator token from the credential file.
Renderer UI actions use the typed `coordinator_ui_tool_call` IPC path instead. That path never
accepts or exposes coordinator bearer tokens; it validates the coordinator run, verifies the
coordinator task owns the run, and requires the task-command lease for mutating actions such as
`spawn_subtask`, `spawn_many`, `start_workflow`, `send_prompt`, and `close_task`.

The helper command is exported to agents as `PARALLEL_CODE_COORDINATOR_TOOL` when a reachable
tool-call URL exists. The credential path is exported as `PARALLEL_CODE_COORDINATOR_CREDENTIAL`,
and the durable run identifier is exported as `PARALLEL_CODE_COORDINATOR_RUN_ID`.

Coordinator prompts are not sent as ordinary free text. The initial coordinator task prompt and
each subtask assignment include the local tool command, the allowed workflow, and the expectation
that subtasks report readiness through coordinator tools. This keeps Codex and custom terminal
agents aligned without importing upstream MCP runtime assumptions.

Workflow state is also backend owned. A workflow snapshot records the template, policy, stages,
lanes, typed results, and journal entries. The renderer only projects that state into the compact
rail; it does not decide stage advancement or result ownership.

## Tools

The current tool surface is intentionally small and explicit:

- `get_task_status` returns the run snapshot.
- `list_tasks` returns the coordinator-owned subtask list.
- `spawn_subtask` creates a hidden task and hidden PTY-backed agent, then queues the assignment.
- `spawn_many` creates or extends a custom fan-out workflow with named lanes. Lane-level spawn
  failures are recorded in the workflow instead of losing the whole call result.
- `start_workflow` creates a backend-owned workflow from a named template. Current templates are
  `custom`, `map_reduce`, and `adversarial_review`.
- `send_prompt` queues a prompt for a run-owned subtask.
- `wait_for_idle` waits for a target subtask to reach backend `idle-at-prompt` supervision.
- `get_task_output` returns a capped tail of the target subtask's backend scrollback.
- `get_task_diff` returns git diff summary, and optionally a capped patch, for a git-backed subtask.
- `signal_done` marks a subtask ready for review.
- `submit_result` lets a subtask submit a typed workflow result with summary, findings, evidence,
  commands run, risks, status, and confidence. The backend binds the result to the lane owned by the
  calling subtask and advances dependent stages when the stage is complete.
- `land_self` validates and lands a git-backed subtask into the coordinator project root.
- `close_task` lets the coordinator explicitly clean up a run-owned subtask without landing it.

Subtasks can call only subtask-owned tools such as `signal_done`, `submit_result`, and `land_self`.
The coordinator task is the only caller allowed to list, inspect, spawn, start workflows, prompt,
wait on, or close subtasks.

## Compact UI

The coordinator task panel renders a compact rail instead of asking users to type raw helper
commands. The rail shows run health, active subtask capacity, pending prompt pressure, attention
counts, compact workflow timelines, and one chip per hidden subtask. Workflow timelines show the
template, result/finding counts, and one marker per stage. They are a projection of backend state,
not an alternate workflow engine. Chips are sorted by attention first, so blocked, failed, landing,
or ready-for-review subtasks stay visible before healthy running work.

Clicking a chip opens a small anchored inspector with output tail, diff, metadata, follow-up, wait,
ask-to-land, and close controls. The `+` button opens a compact spawn form for a new hidden subtask.
The overflow menu keeps debug access, including copying a `list_tasks` helper command, but the raw
CLI helper is no longer the primary UI.

## Safety Rules

Coordinator credentials are bearer tokens and are stored only in per-agent credential files and the
backend token index. Snapshots expose `toolTokenId`, not the token.

Credentials are revoked when a coordinator parent task or subtask is removed through backend task
cleanup. Restored coordinator runs are marked `stale-after-restore` because hidden PTY sessions are
not reconstructed after a server restart.

Prompt delivery goes through the task-command lease path before writing to the PTY. It waits for
backend supervision to report `idle-at-prompt`, backs off while the agent is busy, verifies the exact
lease generation while writing, and retries after supervision or timer events. A prompt blocked by
`awaiting-input` is left for the coordinator to inspect instead of being force-written over a
question.

Prompt queues are bounded per target subtask, and stable prompt/spawn dedupe keys are honored before
creating additional hidden tasks or queue entries. Subtask cleanup cancels queued prompts and
open workflow lanes, then revokes the subtask credential before any later retry can write to the
PTY. Prompt writes are also serialized per target subtask, so direct tool calls and scheduled
retries cannot interleave bytes in the same terminal.

`spawn_subtask` accepts a direct command plus optional args, environment, and skip-permission args.
This is the coordinator-compatible path for Codex and for custom terminal agents. Docker runner
profiles stay outside the support boundary until credential mounting and container networking have
their own design.

Workflow lanes use the same direct-command launch path. Follow-up stages spawned by
`map_reduce` and `adversarial_review` currently use the default `codex` command unless the initial
lane payload overrides the first-stage agent. Agent launch secrets are not persisted inside workflow
snapshots.

`land_self` acquires the coordinator parent task command lease, checks child and parent git status,
merges, runs the real task deletion workflow for the hidden child, revokes the child credential, and
then records the landing result.

## Validation

Coordinator work should prefer browser-free tests first:

- domain guard tests for coordinator snapshots and events
- runtime tests for replayable state and restored stale status
- service tests for credentials, token lookup, revocation, and persistence
- tool-gateway tests for hidden spawn, prompt serialization, prompt retry, authorization, tool
  payload validation, renderer action authorization, output/diff caps, idle waits, workflow
  advancement, typed result submission, partial lane failure, cleanup propagation, and landing
  cleanup
- app projection tests for coordinator rail summaries, attention ordering, prompt beads, landing
  labels, workflow timelines, and legal actions
- Solid tests for the compact coordinator rail, workflow timeline, peek inspector, prompt sending,
  and spawn form
- server-state bootstrap tests for coordinator snapshots and live events
- browser-control-client tests for `coordinator-event` dispatch
- browser-less coordinator E2E tests through `npm run test:node:coordinator:e2e` for the full
  browser-server route shape: HTTP IPC run creation, `/api/coordinator/tool-call`, renderer UI
  actions, task-command leases, duplicate spawn dedupe, custom agent launch config, prompt delivery
  and cancellation, git-only tool rejection for non-git runs, workflow start/result/advance,
  cleanup, stale restore, and websocket replay

Use browser canaries only for actual browser UI creation, rendering, or client-runtime behavior that
the browser-less route tests cannot exercise.
