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
  idempotency state, plus the backend-only durable subtask launch payload store and run-level
  resume audit entries. Launch payloads are persisted in `coordinator-state.json` but are never
  exposed through run snapshots, bootstrap payloads, or coordinator events because caller-supplied
  agent env may carry secrets; coordinator `PARALLEL_CODE_*` env vars are not recorded and are
  rebuilt at respawn. Because the state file can carry caller-supplied agent env, it is written
  with the same owner-only (0600) file permissions as coordinator credential files.
- `service.ts` owns persistence, credential files, token indexes, activity hints, and cleanup.
- `persistence-scheduler.ts` owns the debounced persistence cadence (trailing ~250ms coalesce
  with a 2s max-interval bound, serialized async saves, retry backoff, surfaced degraded health);
  `service.ts` owns the flush points (run creation, task cleanup, shutdown).
- `tool-gateway.ts` owns authorized agent tool execution, renderer action execution, hidden spawn,
  and landing.
- `prompt-delivery.ts` owns the prompt-delivery state machine: readiness policies, seeded versus
  readiness-gated startup contracts, per-target delivery chains and admission caps, bounded queue
  policy, mid-write lease-generation verification, awaiting-input blocking, retry/backoff on
  supervision and timer events, and the run-status admission hook for queued prompt sweeps.
- `handlers.ts` exposes typed IPC handlers. `CoordinatorGetDiagnostics` merges the persistence
  scheduler's health (`degraded`, `lastSuccessAt`, `lastErrorAt`, `lastError`, `pendingFlush`)
  into the diagnostics snapshot so a degraded persistence path is operator-visible.

Coordinator events are granular deltas on exactly one broadcast channel:

- every mutation emits one entity-sized event: `subtask-upserted`, `prompt-upserted`,
  `landing-upserted`, `workflow-upserted` (single workflow snapshot, entityKey
  `workflow:<id>`), or `run-meta-upserted` (run scalars only — status, pausedAt, resumes,
  limits, updatedAt — never the entity collections). `run-upserted` full-run snapshots are
  reserved for run creation and the post-load repair re-emit; `run-removed` stays the tombstone
- the renderer store (`src/store/coordinator.ts`) applies each granular event in place and
  projects the run header (`updatedAt`, `eventVersion`) from the event envelope; a
  `run-meta-upserted` for an unknown run seeds it with empty collections
- browser mode broadcasts each envelope once as the sequenced `coordinator-event` control
  message; the old `ipc-event` duplicate is gone (Electron still emits the
  `IPC.CoordinatorChanged` renderer event from `register.ts`)
- `emitCoordinatorEvent` clones the envelope once, deep-freezes it, and isolates every listener
  in try/catch: a throwing listener (for example a failing persistence write) can no longer
  block the listeners after it or wedge prompt state

Coordinator persistence is debounced, asynchronous, and durable:

- the per-event synchronous whole-world save is gone; coordinator events schedule a coalesced
  async save through the persistence scheduler, and run creation, task cleanup, and the
  loader's async shutdown cleanup flush explicitly (`flushCoordinatorRuntimeState`)
- `coordinator-state.json` keeps a `.bak` sibling on every save; loads fall back to it, and an
  unparseable primary is quarantined to `coordinator-state.json.corrupt-<ts>` first
- runs are validated individually at load: one corrupt run drops only that run (outcome
  `salvaged`, dropped-run count logged) instead of nulling all coordinator state
- the load outcome is explicit (`ok` / `salvaged` / `failed` / `missing`); credential-file orphan
  pruning runs only for `ok`/`missing` loads — a failed or salvaged load never deletes
  credential files for runs it could not see
- saves are compacted: terminal-status runs drop prompt delivery journals and their durable
  launch payloads, and retention is capped by `COORDINATOR_PERSISTENCE_LIMITS` (20 completed
  runs, 20 resumes per run, 100 settled prompts per run, 4MB of tool-call results,
  newest-first). Pending prompts and live-run state are never compacted away
- a prompt stuck in `delivering` with no live delivery owner past
  `STALE_DELIVERING_REQUEUE_MS` (60s) is requeued by the prompt sweep
  (`stale-delivering-requeued`), so a crash or failed status write between the `delivering`
  transition and the terminal status can no longer wedge the prompt forever

Browser mode exposes `POST /api/coordinator/tool-call`. The browser token is not the authority for
that endpoint; each tool call must include the per-task coordinator token from the credential file.
Renderer UI actions use the typed `coordinator_ui_tool_call` IPC path instead. That path never
accepts or exposes coordinator bearer tokens; it validates the coordinator run, verifies the
coordinator task owns the run, and authorizes mutating actions through one declarative per-action
rule table (action to allowed run statuses plus task-command-lease requirement) covering
`spawn_subtask`, `spawn_many`, `start_workflow`, `send_prompt`, `close_task`, and `resume_run`.
Adaptive workflow mutation through `append_workflow_steps` is reserved for coordinator-agent tool
calls; the renderer does not expose it as a direct UI action.

The renderer path also carries operator actions, registered in
`COORDINATOR_OPERATOR_ACTION_NAMES` and dispatched separately from agent tools. Operator actions
are renderer-only: they are not members of `COORDINATOR_TOOL_NAMES`, so the agent tool path
rejects them at the handler boundary. All operator actions require the held task-command lease and
join the same per-action run-status rule table:

- `resume_run` respawns a stale restored run; authorized only while
  `run.status === 'stale-after-restore'`
- `pause_run` stops admission of new work; authorized only while the run is `running`
- `unpause_run` re-admits deferred work; authorized only while the run is `paused-by-user`
- `approve_workflow_actions` and `deny_workflow_actions` resolve a pending decision-action
  approval; authorized while the run is `running`, `draining`, or `paused-by-user`
- `retry_lane` respawns a failed or timed-out workflow lane; authorized only while the run is
  `running`

New human-in-the-loop actions join this list as new rows, not new mechanisms.

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
transport, hidden-spawn, and landing adapter; it does not own the DAG scheduler or the prompt
queue. `electron/coordinator/prompt-delivery.ts` owns prompt delivery.

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
  custom `steps[]` spec. Current templates are `custom`, `map_reduce`, `adversarial_review`, and
  `repo_review`. `repo_review` is the browser-first proving template for this repo: scan backend,
  UI, validation, and docs in parallel, verify the most important findings, decide whether focused
  follow-up work is needed, and synthesize the result. Template workflows are compiled into the
  same normalized spec shape as custom DAG workflows. Caller-supplied specs are accepted only with
  the `custom` template.
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
expansion, retry, timeout, and skipped-stage counts plus a budget counters line (used/limit per
budget dimension, projected read-only from `execution.budget`), latest journal entries,
failed/blocked lane reasons, completion reasons, submitted result summaries, finding previews, and
verifier verdict counts. The timeline and drilldown are projections of backend state, not an alternate
workflow engine. Chips are sorted by attention first, so blocked, failed, landing, or
ready-for-review subtasks stay visible before healthy running work.

Operator controls stay inside the compact rail. The run rail offers a Pause/Unpause control next
to the stale-run Resume button, paused runs render with a warning tone, and pending approvals are
counted as attention. Workflow chips show an `A{n}` badge while approvals are pending, and the
workflow drilldown adds a pending-approvals section (compact validated-action summary with
Approve/Deny, deny behind a two-click confirm) plus a failed-lanes section with per-lane Retry.
All affordances are projected through `coordinator-ui-model` with legal-action gating; the
renderer only issues lease-gated operator requests and never decides outcomes. Every
renderer-initiated operator request routes through the shared
`src/app/coordinator-operator-actions.ts` workflow.

Operator feedback is immediate and readable: busy buttons show an inline spinner, a rejected
resume or pause renders as a full-width dismissable alert strip over the rail (full message in the
tooltip, inline Retry) instead of a truncated inline span, pause/unpause flips the rail status
optimistically with a syncing tone (reverted on rejection, cleared by any newer run snapshot), and
an accepted spawn leaves a ghost `queued` chip in the chips row that survives closing the spawn
form until the subtask lands in a run snapshot or the ack window expires. Stale-after-restore
runs, pending approvals, and budget-exhausted workflows also surface outside the rail as
renderer-side task attention (sidebar badges plus a one-click Resume in the task title bar).

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
cleanup.

Restored coordinator runs are marked `stale-after-restore` because hidden PTY sessions are never
reattached after a server restart, but a stale run is now resumable through the explicit
lease-gated `resume_run` renderer action (surfaced as the Resume button on the stale run banner):

- completed lanes, results, verdicts, step appends, and expansions replay as immutable cached
  facts; resume never rewrites, reorders, or re-applies them
- unfinished work is respawned, never reattached: interrupted subtasks (marked
  `interruptedByRestoreAt` at restore) and stale workflow lanes without results get a fresh PTY
  agent in the same hidden task and worktree, launched from the durable launch payload recorded
  backend-only at original spawn time; subtasks without a recorded payload fail explicitly
  instead of being guessed
- respawned subtasks get rotated credentials: the old subtask token is revoked, a fresh credential
  file is written, and the agent env is rebuilt
- `write-unknown-after-restore` prompts are terminal facts and are never redelivered. A
  readiness-gated respawn still gets a fresh initial-assignment prompt because the original prompt
  targeted a dead PTY; codex re-seeds the assignment into launch args, while readiness-gated
  agents re-queue it with a deterministic `resume:<resumeId>:<taskId>:initial` dedupe key
- resume is replay-safe: repeated `resume_run` with the same `requestId` returns the remembered
  result, a second resume is rejected because the run is no longer stale, never-spawned stale
  lanes are replaced exactly once through deterministic `:resume:` dedupe keys with
  `spawnedBy: 'resume'` lane provenance, and a crash mid-resume self-heals because the next boot
  re-marks in-flight state stale again. A never-spawned lane is cancelled only after its
  replacement spawn succeeds, and that superseded cancelled lane never cancels the stage: stage
  completion ignores cancelled lanes whose `:resume:` replacement exists, so the replacement's
  result completes the stage normally. If the replacement is blocked by lane caps or fails to
  spawn, the original lane is marked failed with the reason instead
- per-target failures are isolated: a failed respawn marks that lane or subtask failed, a
  workflow whose resume throws is recorded as failed while the remaining workflows still resume,
  and the outcome is recorded in the run-level `resumes[]` audit entry (journal kinds
  `workflow-resumed`, `lane-respawned`, `lane-respawn-failed`)
- the visible coordinator parent task stays renderer-owned: its agent is restarted through the
  normal visible-agent restart affordance, and its existing credential works again once the run
  is resumed

Prompt delivery goes through the task-command lease path before writing to the PTY. Initial
assignment and follow-up prompting are separate contracts:

- seeded-start subtasks receive their first assignment in the process launch arguments and do not
  queue an initial prompt
- readiness-gated subtasks queue their initial assignment like any other prompt, including after a
  respawn where the pre-restart prompt had already been delivered
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
retries cannot interleave bytes in the same terminal. Prompt-delivery admission is tracked per
active target delivery chain rather than per queued request, so a second prompt already waiting
behind the same terminal does not consume another global or per-run delivery slot.

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

Spec-backed workflows now use the version `2` normal form. The backend still accepts legacy
version `1` specs, but normalizes them into the current shape before execution. Version `2`
adds richer fan-in and adaptive branch ergonomics without introducing an imperative script runner:

- step policy may define `joinMode` as `all`, `any`, `first-success`, or `quorum`
- quorum fan-in may also define `quorumCount`
- verify steps may define `minimumVerifierCount`, but it must stay satisfiable for the verifier set
  and selected join policy
- workflow policy may define `maxIterationsPerBranch`
- workflow policy may define the optional per-workflow budget ceilings `maxTotalSteps`,
  `maxTotalLanes`, `maxTotalRetries`, and `maxWallClockMs`
- decision-lane workflow actions may use `append_branch_bundle` to append a named fan-out branch
  with optional verify and reduce stages in one validated action

`all` keeps the old barrier behavior. `any`, `first-success`, and `quorum` let downstream stages
start once enough upstream results exist even if the upstream stage still has active lanes. The
executor treats that as dependency satisfaction, not full upstream completion. The stage remains
visible as `waiting-for-results` until its remaining lanes finish or fail.

The backend rejects invalid specs before creating workflow state: duplicate step IDs, missing
dependencies, dependency cycles, missing verifier sources, empty fanout/verifier sets, malformed
agent launch configs, impossible verifier thresholds or quorums, over-cap lane counts including
implicit synthesis and template follow-up
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

`append_branch_bundle` is the structured adaptive path for iterative follow-up work. One action
appends:

- a fan-out branch stage
- an optional verify stage over that branch
- an optional reduce stage over the branch and verifier results

The backend records `branchKey`, `bundleId`, and iteration count in the expansion audit entry,
enforces `maxIterationsPerBranch`, validates the fully expanded steps as one batch, and rejects the
whole action before state changes when the branch would exceed workflow policy.

Retry and timeout policy is enforced by the backend executor and driven by the coordinator runtime
scheduler. Timed-out lanes become terminal, queued prompts for that lane are cancelled, retry lanes
are admitted only after their backoff and while retry budget and lane caps remain, and cancelled or
stale-restored workflows cannot schedule follow-up work.

Every workflow also carries four global budget ceilings: total steps, total lanes (planned plus
appended, including implicit synthesis and template follow-up lanes), total retries across lanes,
and total wall-clock time. Defaults and hard caps live in `COORDINATOR_LIMITS`; workflow policy can
never raise an effective limit above its hard cap. For steps, lanes, and retries the default equals
the hard cap, so policy can only lower those limits. Wall-clock is the one dimension with a default
(`workflowDefaultWallClockMs`, one hour) below its hard cap (`workflowMaxLaneTimeoutMs`, twenty-four
hours), so policy may set `maxWallClockMs` anywhere up to that cap. Above-cap policy payloads are
rejected at the tool boundary, and restored or hand-edited snapshots are clamped through
`getCoordinatorWorkflowBudgetLimits`. All four ceilings are validated in the same
validate-before-any-state-change path as appends: `start_workflow` admission, `append_workflow_steps`,
decision-lane `metadata.workflowActions`, `spawn_many` lane extension, scheduler retry admission, and
resume replacement-lane spawn all route through one lane-admission authority
(`getCoordinatorWorkflowBudgetLimits` plus `getCommittedWorkflowLaneCount`), which counts
materialized lanes plus the planned lanes of not-yet-started stages.

Budget exhaustion is recorded with one journal kind, `workflow-budget-exhausted`, and the typed
`execution.budget` state (per-dimension used/limit plus the exhausted dimension) is the source of
truth; the human-readable form is fixed as `budget-exhausted: <dimension> (<used>/<limit>)`.
Wall-clock or lane exhaustion trips the workflow through one shared close-out path
(`closeOutCoordinatorWorkflowWork`): active lanes are cancelled, pending stages are skipped, the
journal entry is written, and the workflow becomes `blocked` with the typed reason, so a tripped
workflow rejects further appends instead of growing. Trips are terminal-state aware: an already
blocked or completed workflow is never re-tripped. Later ticks on a blocked workflow are no-ops,
and a past-deadline append that tries to reopen a completed workflow is rejected with the typed
reason without rewriting the recorded completion. Retry exhaustion never trips the workflow: it
only stops admitting retry lanes, journals `workflow-budget-exhausted` once, and lets the stage
finish through normal completion semantics. Retry counting is provenance-aware: only
scheduler-spawned lanes with `attempt > 1` consume the retry budget, and lanes spawned by `resume`
or `operator` provenance are excluded from the counter entirely.

The wall-clock deadline is seeded at workflow start (`startedAt + maxWallClockMs`), checked at the
head of every executor tick, and woken exactly at the deadline by the runtime scheduler. Server
downtime does not consume wall-clock budget: resume extends the deadline by the stale gap inside
the resume clock-refresh hook, so a resumed workflow is not instantly tripped. By design,
wall-clock continues to run while a run is paused by the operator, because timeout ticks stay
alive while a run is paused.

`pause_run` stops admission of NEW work while in-flight lanes finish and their results are still
accepted. The paused-run gate is enforced consistently at every admission seam: queued prompt
sweeps and direct prompt admission are skipped through the prompt-delivery run-status admission
hook (`coordinatorRunAdmitsPromptDelivery`), the executor reconcile defers scheduler retries and
ready-stage spawns, retry-driven scheduler wake-ups are suppressed, agent tool calls that admit
new work (`spawn_subtask`, `spawn_many`, `start_workflow`, `append_workflow_steps`,
`send_prompt`) are rejected with `Coordinator run is paused-by-user`, and renderer mutations
follow the per-action rule table. Read-only inspection tools, `wait_for_idle`, `submit_result`,
`signal_done`, `close_task`, and `land_self` stay available so in-flight work can settle. Lane
timeouts and wall-clock budget trips still fire while paused. Pause and unpause are journaled on
each active workflow with the exact kinds `run-paused` and `run-unpaused`. `unpause_run`
reconciles every active workflow (deferred retries and ready stages spawn) and force-kicks the
prompt sweep. The
`pausedAt` marker survives restore: a paused run that goes stale across a restart is resumed by
`resume_run` back to `paused-by-user` (work is respawned, admission stays gated) and `unpause_run`
is the explicit second step.

Workflow policy may opt into operator approval for decision-lane workflow actions with
`requireDecisionApproval`. A gated decision result is validated exactly like the ungated path,
then recorded as a pending approval (`pendingApprovals` on the workflow, journal kind
`decision-approval-requested`) instead of being applied: the decision lane stays open without a
lane result, so stage completion and every join mode keep dependents blocked, and the lane's
timeout is cleared because it now waits on the operator. `approve_workflow_actions` re-validates
the stored actions against the CURRENT graph (budgets and caps may have changed since the
request), including the per-workflow append budget that other appends may have consumed while the
approval was pending, completes the lane, and applies the actions through the same validated
append-only mutation path; a failed re-validation leaves the approval pending and deny remains the
escape hatch. `deny_workflow_actions` discards the actions with a journaled reason and closes the
lane with the recorded result status: for append-gated results the status is `completed`, so
dependents proceed, while denying a `mark_blocked`-gated result closes the lane `blocked` and
keeps dependents gated — the agent's blocked assessment is preserved while the workflow-level
action is discarded. Approvals are append-only audit entries with
exactly one resolution (`approved`, `denied`, or `cancelled`); approve and deny are idempotent per
approval id. Pending approvals are never stranded: workflow cancellation, subtask cleanup, budget
trips through the shared close-out path, and restore all resolve them as `cancelled` with the
close-out reason (journal kind `decision-approval-cancelled`). On resume, a decision lane whose
approval was cancelled by restore re-enters its awaiting state with a re-recorded pending approval
instead of completing as a cached fact, so gated actions always get an explicit operator decision.

`retry_lane` is the operator path for reviving a failed or timed-out lane that has no result. It
is exempt from per-stage `retryCount` and from the auto-retry budget counter (the retry lane is
spawned with `spawnedBy: 'operator'`), but it stays inside the same effective lane caps as every
other admission site (`getCoordinatorWorkflowBudgetLimits` plus `getCommittedWorkflowLaneCount`
and `maxConcurrentLanes`) and reuses the auto-retry dedupe key scheme, so a manual and a scheduled
retry can never double-spawn the same attempt. Each manual retry is journaled as
`lane-manual-retry`.

`land_self` acquires the coordinator parent task command lease, checks child and parent git status,
merges, runs the real task deletion workflow for the hidden child, revokes the child credential, and
then records the landing result.

## Design Boundaries

These are standing rules for future coordinator work, not temporary limitations:

- No imperative runner. Workflow specs stay constrained declarative data; the backend never
  evaluates caller-supplied control flow, expressions, or scripts.
- No control-flow language in the spec. Branching, iteration, and termination exist only as
  validated decision-lane actions and appends recorded in the workflow audit trail.
- Adaptivity only through validated append-only mutation. Existing steps, stages, lanes, results,
  and verdicts are never rewritten, reordered, or deleted by later actions.
- The renderer never owns workflow logic. Stage advancement, retry, timeout, append validity,
  verification, and budget decisions are backend owned; the UI is a projection plus lease-gated
  requests.
- Operator approval is a validated gate in front of the same append-only mutation path, not a new
  mutation kind.

Pressure to add "just one more" branch or loop primitive should be answered with a validated append
action shape, or rejected, not with spec-level control flow.

## Validation

Coordinator work should prefer browser-free tests first:

- domain guard tests for coordinator snapshots and events
- runtime tests for the granular event vocabulary (one entity-sized event per mutation,
  `run-meta-upserted` for run scalar changes, `workflow-upserted` from workflow writes),
  per-listener exception isolation, and the shared deep-frozen envelope clone
- persistence tests for per-run salvage, `.bak` fallback, quarantine-on-corrupt, explicit load
  outcomes, legacy uncompacted files, and the save-time compaction caps
  (`electron/coordinator/persistence.test.ts`); fake-timer scheduler tests for burst coalescing,
  the max-interval bound, degraded health with backoff recovery, and flush/stop durability
  (`electron/coordinator/persistence-scheduler.test.ts`)
- service tests proving no synchronous fs write per emitted event, sub-5ms per-event emit
  latency against a multi-MB fixture, and that failed or salvaged loads never delete
  credential files
- runtime tests for replayable state, restored stale status, restore interruption markers,
  launch-payload round-trips that stay out of bootstrap snapshots, the stale-to-running
  resume transition with its `resumes[]` audit, the paused marker set/clear and
  restore-as-stale-then-resume-to-paused contract, append-only pending-approval mutation, and
  approval cancellation on restore and subtask cleanup
- service tests for credentials, token lookup, revocation, persistence, launch-payload
  persistence, and legacy state files without launch payloads
- prompt-delivery tests for prompt serialization, queued and direct prompt admission caps,
  `awaiting-input` blocking, mid-write lease-loss failure, readiness-policy gating, prompt dedupe
  and per-target bounds, follow-up contract rejection, initial-assignment status mirroring,
  paused-run admission gating through the run-status hook with delivery after unpause,
  stale-`delivering` requeue after the deadline, and delivery-loop lifecycle churn
- workflow-executor tests for resume semantics: cached-fact replay including recorded expansions
  and verdicts, respawn with refreshed `timeoutAt` outside the retry budget, respawn-failure
  isolation, deterministic never-spawned lane replacement plus stage completion after the
  replacement submits its result, replacement-lane cap rejection, append idempotency across
  restore plus resume, and non-stale resume rejection
- workflow-executor tests for budget enforcement: start/append/decision-action rejection over
  lowered step and lane budgets with no state mutation, committed-lane counting that includes
  planned lanes of pending stages, retry suppression at the retry budget with a single
  `workflow-budget-exhausted` journal entry, wall-clock trips at the tick head with the typed
  blocked reason, trip idempotence across repeated ticks, completed-workflow late-append rejection
  without a trip, exactly-at-limit admission for the step budget and trip-at-exactly-deadline
  wall-clock semantics, zero-retry-budget suppression, deadline-driven scheduler wake-ups, append
  idempotency after a trip, the lane-budget backstop blocking instead of failing, and
  resume-past-deadline extension by the stale gap
- workflow-executor tests for operator controls: gated decision results held without a lane
  result so dependents stay blocked, approve-time re-validation against the grown graph
  (including the lane and append budgets) that leaves rejected approvals pending, idempotent
  approve and deny resolution, deny closing the lane with the recorded result status (dependents
  proceed for append-gated results; a denied `mark_blocked`-gated result keeps them gated),
  budget close-out and workflow cancellation resolving pending
  approvals, resume re-recording restore-cancelled approvals instead of replaying cached facts,
  paused-run deferral of retries and ready stages while timeouts still fire, and operator lane
  retries outside the auto-retry counter but inside the effective lane caps with shared dedupe
  keys
- tool-gateway tests for hidden spawn, supervision-driven prompt retry through `send_prompt`,
  authorization, tool payload validation, renderer action authorization, the operator-action
  matrix (lease-gated per-action run-status rules for `resume_run`, `pause_run`, `unpause_run`,
  `approve_workflow_actions`, `deny_workflow_actions`, and `retry_lane`, all rejected on the
  agent tool path), paused-run agent admission (spawn/prompt rejected while inspection and
  in-flight completions stay accepted), the gated submit path that records pending approvals,
  launch payload recording and cleanup, credential rotation on respawn, seeded versus readiness-gated
  initial-assignment re-establishment, write-unknown non-redelivery, output/diff caps, idle
  waits, workflow advancement, adaptive step appends, decision-lane workflow actions, typed result
  submission, partial lane failure, typed verifier verdicts, cleanup propagation, and landing
  cleanup
- app projection tests for coordinator rail summaries, attention ordering, prompt beads, landing
  labels, workflow timelines, join progress, blocked and failed stage counts, append and branch
  activity, result previews, pause/unpause controls, pending-approval attention and gating,
  manual-retry lane projection, exact operator journal-kind tones, and legal actions
- Solid tests for the compact coordinator rail, workflow timeline, peek inspector, prompt sending,
  pause/approve/deny/retry operator affordances, and spawn form
- server-state bootstrap tests for coordinator snapshots and live events
- browser-control-client tests for `coordinator-event` dispatch
- browser-less coordinator E2E tests through `npm run test:node:coordinator:e2e` for the full
  browser-server route shape: HTTP IPC run creation, `/api/coordinator/tool-call`, renderer UI
  actions, task-command leases, duplicate spawn dedupe, custom agent launch config, prompt delivery
  and cancellation, seeded initial assignment, follow-up prompt rejection for disallowed subtasks,
  `awaiting-input` blocking, Codex readiness detection, git-only tool rejection for non-git runs,
  workflow start/result/advance, adaptive append/result/advance, decision-lane workflow actions,
  invalid spec rejection, spec-backed fanout/verify/synthesize workflows, quorum fan-in,
  `repo_review` template execution, focused branch-bundle appends, above-cap budget policy
  rejection, a wall-clock budget trip that blocks the workflow with the typed reason and rejects
  further appends, a gated decision approval round-trip (request, leased approve, appended steps
  spawning) plus a deny path that lets dependents proceed, pause blocking prompt delivery and
  spawns with unpause delivering the deferred prompt, `retry_lane` within the effective lane
  budget with a no-lease 400 for each operator action, cleanup, stale restore,
  restart-then-`resume_run` respawn with rotated credentials and replay-safe idempotency, and
  websocket replay

Use browser canaries only for actual browser UI creation, rendering, or client-runtime behavior that
the browser-less route tests cannot exercise.
