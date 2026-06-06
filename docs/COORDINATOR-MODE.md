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
Adaptive workflow mutation through `append_workflow_steps` is reserved for coordinator-agent tool
calls; the renderer does not expose it as a direct UI action.

The helper command is exported to agents as `PARALLEL_CODE_COORDINATOR_TOOL` when a reachable
tool-call URL exists. The credential path is exported as `PARALLEL_CODE_COORDINATOR_CREDENTIAL`,
and the durable run identifier is exported as `PARALLEL_CODE_COORDINATOR_RUN_ID`.

Coordinator prompts are not sent as ordinary free text. The initial coordinator task prompt and
each subtask assignment include the local tool command, the allowed workflow, and the expectation
that subtasks report readiness through coordinator tools. Hidden Codex subtasks now seed their
initial assignment at spawn by default instead of waiting for a shell-style prompt, while follow-up
prompts still use the readiness-gated delivery path. This keeps Codex and custom terminal agents
aligned without importing upstream MCP runtime assumptions.

Workflow state is also backend owned. A workflow snapshot records the template, optional normalized
`steps[]` spec, append policy, append audit entries, recorded expansions, execution policy, stages,
lanes, typed results, verifier verdicts, and sequenced journal entries. The renderer only projects
that state into the compact rail; it does not decide stage advancement, result ownership, retry,
timeout, append validity, or verification outcomes.

`electron/coordinator/workflow-executor.ts` owns the workflow state machine. It compiles fixed
templates and custom `steps[]` payloads into the same stage/lane representation, starts ready
dependency stages, records timeout/retry/cancel execution state, aggregates typed verifier
verdicts, applies decision-lane workflow actions into append-only graph mutation, and writes
replayable journal entries. `electron/coordinator/tool-gateway.ts` remains the authorization,
transport, hidden-spawn, prompt-delivery, and landing adapter; it does not own the DAG scheduler.

## Tools

The current tool surface is intentionally small and explicit:

- `get_task_status` returns the run snapshot.
- `list_tasks` returns the coordinator-owned subtask list.
- `spawn_subtask` creates a hidden task and hidden PTY-backed agent. Codex subtasks default to a
  seeded initial assignment at spawn; generic/custom terminal agents still use the readiness-gated
  prompt queue for the initial assignment.
- `spawn_many` creates or extends a custom fan-out workflow with named lanes. Lane-level spawn
  failures are recorded in the workflow instead of losing the whole call result.
- `start_workflow` creates a backend-owned workflow from a named template or from a constrained
  custom `steps[]` spec. Current templates are `custom`, `map_reduce`, and `adversarial_review`.
  Template workflows are compiled into the same normalized spec shape as custom DAG workflows.
  Caller-supplied specs are accepted only with the `custom` template.
- `append_workflow_steps` lets the coordinator task or a workflow-lane subtask append new `steps[]`
  to an existing source-spec-backed workflow. The payload includes `workflowId`, `appendId`,
  `steps`, optional `reason`, and optional `laneId` for disambiguating subtask ownership. Appends
  are append-only and idempotent by `appendId`; repeated calls with the same steps return the
  existing append, while reusing an `appendId` for different steps is rejected. Appended steps are
  normalized against the whole workflow graph before any state changes, and ready appended stages
  are reconciled immediately.
- `send_prompt` queues a follow-up prompt for a run-owned subtask. Subtasks whose launch contract
  disallows follow-up prompts reject it instead of silently queueing an unreachable write.
- `wait_for_idle` waits for a target subtask to reach backend `idle-at-prompt` supervision.
- `get_task_output` returns a capped tail of the target subtask's backend scrollback.
- `get_task_diff` returns git diff summary, and optionally a capped patch, for a git-backed subtask.
- `signal_done` marks a subtask ready for review.
- `submit_result` lets a subtask submit a typed workflow result with summary, findings, evidence,
  commands run, risks, status, confidence, and optional verifier verdict metadata. The backend binds
  the result to the lane owned by the calling subtask, assigns stable finding IDs when omitted,
  records typed verdict snapshots, and advances dependent stages when the stage is complete.
  Decision lanes may also include `metadata.workflowActions` with structured append or terminal
  actions. The backend validates those actions, converts append actions into new `steps[]`, records
  the resulting expansion, and rejects invalid or out-of-policy mutations before the workflow
  changes.
- `land_self` validates and lands a git-backed subtask into the coordinator project root.
- `close_task` lets the coordinator explicitly clean up a run-owned subtask without landing it.

Subtasks can call only subtask-owned tools such as `signal_done`, `submit_result`, `land_self`, and
`append_workflow_steps` for lanes they own. The coordinator task is the only caller allowed to list,
inspect, spawn, start workflows, prompt, wait on, or close subtasks.

## Compact UI

The coordinator task panel renders a compact rail instead of asking users to type raw helper
commands. The rail shows run health, active subtask capacity, pending prompt pressure, attention
counts, compact workflow timelines, and one chip per hidden subtask. Workflow timelines show the
template, result/finding counts, append and expansion counts, verdict counts, latest activity, and
one marker per stage. Clicking a workflow opens a compact passive drilldown with step, append,
expansion, retry, timeout, and skipped-stage counts plus latest journal entries, failed/blocked
lane reasons, completion reasons, submitted result summaries, finding previews, and verifier
verdict counts. The timeline and drilldown are projections of backend state, not an alternate
workflow engine. Chips are sorted by attention first, so blocked, failed, landing, or
ready-for-review subtasks stay visible before healthy running work.

Clicking a chip opens a small anchored inspector with output tail, diff, metadata, follow-up, wait,
ask-to-land, and close controls. The `+` button opens a compact spawn form for a new hidden subtask.
The overflow menu keeps debug access, including copying a `list_tasks` helper command, but the raw
CLI helper is no longer the primary UI. The chip metadata and passive detail line also project the
launch contract: seeded-at-spawn versus prompt-delivered startup, whether follow-up prompts are
allowed, the readiness policy in effect, and any current prompt wait reason.

## Safety Rules

Coordinator credentials are bearer tokens and are stored only in per-agent credential files and the
backend token index. Snapshots expose `toolTokenId`, not the token.

Credentials are revoked when a coordinator parent task or subtask is removed through backend task
cleanup. Restored coordinator runs are marked `stale-after-restore` because hidden PTY sessions are
not reconstructed after a server restart.

Prompt delivery goes through the task-command lease path before writing to the PTY. Initial
assignment and follow-up prompting are separate contracts:

- seeded-start subtasks receive their first assignment in the process launch arguments and do not
  queue an initial prompt
- readiness-gated subtasks queue their initial assignment like any other prompt
- follow-up prompts always wait for backend supervision to report `idle-at-prompt`, back off while
  the agent is busy, verify the exact lease generation while writing, and retry after supervision
  or timer events

A prompt blocked by `awaiting-input` is left for the coordinator to inspect instead of being
force-written over a question. Codex readiness detection also recognizes the visible Codex composer
prompt, not only shell-style prompts, so follow-up delivery can recover once the TUI is actually
ready.

Prompt queues are bounded per target subtask, and stable prompt/spawn dedupe keys are honored before
creating additional hidden tasks or queue entries. Subtask cleanup cancels queued prompts and
open workflow lanes, then revokes the subtask credential before any later retry can write to the
PTY. Prompt writes are also serialized per target subtask, so direct tool calls and scheduled
retries cannot interleave bytes in the same terminal.

`spawn_subtask` accepts a direct command plus optional args, environment, and skip-permission args.
This is the coordinator-compatible path for Codex and for custom terminal agents. Docker runner
profiles stay outside the support boundary until credential mounting and container networking have
their own design.

Workflow lanes use the same direct-command launch path. Follow-up stages spawned by fixed templates
or custom specs use the default `codex` command unless the spec/lane payload supplies an agent.
Agent launch secrets are not persisted inside workflow snapshots. Workflow specs can also override
the startup contract per agent through `initialAssignmentMode`, `followupPromptMode`, and
`readinessPolicy`; the current default for `codex` remains seeded interactive startup with
readiness-gated follow-up prompts. `readinessPolicy` is not cosmetic: `codex` and `shell` decide
which prompt shapes count as ready before the backend writes a follow-up, while
`terminal-generic` trusts the existing `idle-at-prompt` supervision state.

Custom workflow specs are intentionally constrained data, not executable scripts. Supported step
kinds are:

- `decision`: one decision lane that may append validated follow-up steps or terminate the workflow.
- `fanout`: many named worker lanes under one dependency step.
- `worker`: one worker lane.
- `verify`: verifier lanes that evaluate findings or results from prior steps and submit typed
  verdicts.
- `synthesize`: one synthesis lane over prior results and optional verdicts.

The backend rejects invalid specs before creating workflow state: duplicate step IDs, missing
dependencies, dependency cycles, missing verifier sources, empty fanout/verifier sets, malformed
agent launch configs, over-cap lane counts including implicit synthesis and template follow-up
lanes, invalid timeout/retry policy, oversized payloads, and unsupported spec versions.

Appended workflow steps use the same validation rules against `existing steps + appended steps`.
Existing steps, stages, lanes, results, and verdicts are never rewritten or reordered. New step IDs
must be globally unique, new dependency and source references may point to either existing or newly
appended steps, and explicit lane dedupe keys must not collide with existing or appended planned
lanes. Blocked, cancelled, failed, and stale-restored workflows reject appends. Running workflows
can grow in place, and completed workflows can be reopened by a valid append; the backend clears the
old completion marker, records a `workflow-steps-appended` journal entry, refreshes execution
state, and immediately reconciles ready stages. Workflow-lane subtasks must append before they
submit a terminal result. Decision-lane `metadata.workflowActions` go through the same append-only
validation path and are capped by per-workflow append and per-result action limits.

Retry and timeout policy is enforced by the backend executor and driven by the coordinator runtime
scheduler. Timed-out lanes become terminal, queued prompts for that lane are cancelled, retry lanes
are admitted only after their backoff and while retry budget and lane caps remain, and cancelled or
stale-restored workflows cannot schedule follow-up work.

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
  advancement, adaptive step appends, decision-lane workflow actions, typed result submission,
  partial lane failure, typed verifier verdicts, cleanup propagation, and landing cleanup
- app projection tests for coordinator rail summaries, attention ordering, prompt beads, landing
  labels, workflow timelines, append activity, and legal actions
- Solid tests for the compact coordinator rail, workflow timeline, peek inspector, prompt sending,
  and spawn form
- server-state bootstrap tests for coordinator snapshots and live events
- browser-control-client tests for `coordinator-event` dispatch
- browser-less coordinator E2E tests through `npm run test:node:coordinator:e2e` for the full
  browser-server route shape: HTTP IPC run creation, `/api/coordinator/tool-call`, renderer UI
  actions, task-command leases, duplicate spawn dedupe, custom agent launch config, prompt delivery
  and cancellation, seeded initial assignment, follow-up prompt rejection for disallowed subtasks,
  Codex readiness detection, git-only tool rejection for non-git runs, workflow start/result/advance,
  adaptive append/result/advance, decision-lane workflow actions, invalid spec rejection,
  spec-backed fanout/verify/synthesize workflows, cleanup, stale restore, and websocket replay

Use browser canaries only for actual browser UI creation, rendering, or client-runtime behavior that
the browser-less route tests cannot exercise.
