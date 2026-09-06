# Testing Strategy

This document explains what Parallel Code tests are meant to prove.

This document owns:

- validation layers and seam choice
- what counts as sufficient proof
- reusable failure patterns and harness guidance
- the testing quality bar for risky changes

This document does not own:

- exact command strings or every wrapper invocation
- terminal/browser-lab runbooks
- architecture ownership policy
- product pain taxonomy and validation objectives
- cross-cutting review heuristics

For exact commands, use repo scripts and `package.json`. For terminal/browser workflow, use
[TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md). For ownership decisions, use
[ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) and
[ARCHITECTURE.md](./ARCHITECTURE.md). For user-frustration-driven validation intent, use
[PRODUCT-VALIDATION-OBJECTIVES.md](./PRODUCT-VALIDATION-OBJECTIVES.md).

## Focus

This strategy covers:

- reconnect and replay behavior
- startup, persistence, and reconciliation
- multi-client presence, takeover, and control
- server-owned pushed state
- terminal rendering, restore, recovery, and focus
- preview detection, exposure, and auth routing
- task container inspect, lifecycle, and logs
- handler and persistence boundary validation
- high-churn product screens
- shared test harness hygiene

It answers:

- what kinds of failures need proof
- which validation seam should catch them
- which edge cases are easy to miss
- what counts as sufficient coverage for risky changes

It also records which seams should catch current architecture splits:

- store boundary drift should be caught by architecture tests before component tests
- TaskPanel permission-flow regressions should be caught by `TaskPanel.architecture.test.ts` and
  `TaskPanel.test.tsx`
- ReviewPanel loading/selection drift should be caught by
  `review-surfaces.architecture.test.ts` and `ReviewPanel.test.tsx`
- terminal startup and replay regressions should be caught by a mix of `Solid / UI` and
  `runtime / integration` proofs

## Validation Layers

Parallel Code uses four main validation layers:

1. `node / backend`
   - contract, handler, workflow, replay, ordering, and recovery semantics
2. `Solid / UI`
   - high-churn screen and component behavior
3. `runtime / integration`
   - real browser, multi-client, restore, focus, and stress/diagnostics behavior
4. `docs / sanity only`
   - documentation-only changes with no runtime behavior impact

Architecture/source-level tests protect constraints such as bootstrap ownership,
store-boundary imports, focused-panel reads, and review-surface composition. They are not a
substitute for behavior proof. They fail early when ownership drifts.

## Core Principles

Keep the testing strategy aligned with these rules:

1. Test architectural contracts and user-visible behavior, not temporary helper structure.
2. Prefer server-authoritative contracts for server-owned state.
3. Prefer race, replay, ordering, and recovery coverage over shallow collaborator-call assertions.
4. Use the thinnest seam that can still prove the real risk.
5. Use more than one seam when the failure can cross ownership boundaries.
6. Add tests that remain valuable after refactors instead of tests that mirror current plumbing.
7. When a server-owned category has both bootstrap snapshots and live events, add one projection
   test proving both paths land in the same canonical stored shape.

For task-container work:

- keep most proof in `node / backend`
- treat inspect/start/stop/destroy/logs as a lifecycle/state-machine seam, not as shell-command
  wrappers
- keep preview-manager UI proof focused on rendering, action wiring, and explicit error-state
  presentation, not Docker internals
- when the task-panel preview controller changes, add explicit proof for stale-request suppression,
  inspect/log/action rejection handling, and stale action-error clearing after fresh inspect truth
- only require `runtime / integration` browser proof when container behavior crosses routed preview
  auth/transport boundaries or other browser-owned multi-client ownership seams; backend Docker
  execution proof belongs in the dedicated real-Docker node lane

For agent-runner work:

- keep Docker agent execution proof separate from task-container/Compose preview proof
- prove per-agent and global stop admission as one lifecycle: every spawn initiated after stop
  begins is rejected through pending-spawn drain and runner cleanup, even behind a cancelled
  predecessor; overlapping stops share one attempt, failed cleanup keeps admission closed, and an
  explicit successful retry reopens it; synchronous cleanup throws must not skip later owners
- prove profile normalization, Docker argument construction, exact-label cleanup, and runner
  identity projection in `node / backend` tests
- use `npm run test:node:docker:agent-runner` for optional local real-Docker proof and
  `npm run test:node:docker:agent-runner:required` when pre-release proof must fail without a
  reachable Docker daemon
- keep renderer proof focused on configuration, command-target projection, and visible/passive
  terminal behavior; renderer code must not own Docker lifecycle truth

For ordinary task-prompt and question-state work:

- prove the pure editor policy across every canonical state and blocker precedence: peer control,
  IME composition, current-generation local question evidence, canonical question state,
  send-in-flight, and empty draft
- prove a question leaves the editor focused and editable, makes plain Enter a newline, leaves
  Shift+Enter unchanged, and blocks button/keyboard/programmatic dispatch; use real Chromium for
  focus because a component mock cannot prove browser focus stability
- prove local question evidence ignores stale generations and revisions, resets on lifecycle
  replacement, survives duplicate same-generation running/spawn observations and same-PTY
  pause/resume, and shares prompt/question fixtures with backend supervision
- prove backend byte admission keeps ordinary non-question states eligible, makes initial delivery
  ready-only, and rejects task-closing, question, generation, version, control, and lease changes
  before bytes; separately prove a transition or throw after first-frame admission is ambiguous
- prove ordinary and initial/manual producers share the same per-agent admission tail with a
  deterministic cross-owner race: a queued ordinary send cannot interleave between a multiline
  first frame and submit frame, and must revalidate structural closing plus its captured
  generation/version when its turn begins; separately prove initial admission rejects when live PTY
  metadata disappears while a lagging supervision snapshot still looks ready
- prove Electron and authenticated browser paths capture controller/task identity in the backend,
  and prove the semantic browser side effect makes exactly one network attempt with zero queued
  replay after transport loss
- prove an accepted send clears only the exact dispatched text and revision, while rejection,
  ambiguity, peer-control loss, and edits made in flight preserve the visible draft
- keep the O(1) policy and admission p99 budgets executable, and pair component render/focus limits
  with a noisy real-browser key-to-text latency budget and a compressed bundle budget

For task-notes work:

- prove the pure reducer and transport-neutral controller separately: immutable submitted text,
  absorbing completed truth, greatest-revision selection, lifecycle ordering, timeout/retry paths,
  conflict/closing/orphan recovery, invalidation coalescing, and bounded acknowledgement reclamation;
- prove desktop debounce and mobile explicit Save at the component seam, including edits made while
  saving, app/task draft retention, unload/discard guards, and send-as-prompt reading the visible
  draft rather than stale canonical state;
- prove the remote Terminal/Notes switch does not create, dispose, or resubscribe the terminal, and
  use real Chromium for input p95, terminal preservation, payload bytes, and mobile accessibility;
- keep `electron/ipc/task-notes-service.benchmark.test.ts` as the named authenticated coherent-read
  service-boundary gate for 100 KiB hashing/fingerprints, exact write classes, 10,000 acknowledged
  saves, bounded operation-segment codec cost, and wire bytes. Keep
  `tests/browser/task-notes-performance.spec.ts` as the real key-to-input, HTTP payload,
  issue/save/replay, DOM-commit, and terminal-preservation proof;
- prove the pre-admission operation snapshot is detached and write-free, does not join the mutation
  queue, and is revalidated by the next mutation. Hold a commit after rename to prove the
  identity-shared inspection epoch rejects proposed truth until healthy settlement; pending
  durability and startup ambiguity must keep both inspection and writes closed;
- make `tests/harness/remote-feature-bundle-budget.test.ts` traverse the Vite manifest's complete
  static lazy closure (including CSS and shared static imports after subtracting the eager closure),
  rather than measuring only a route entry file. D14 accepts at most 9 KiB gzip for the mandatory
  Notes first-open closure, including its statically owned runtime, and separately at most 3 KiB
  gzip for the incremental on-demand recovery closure after subtracting already-loaded mandatory
  assets. The split prevents an immediately fetched runtime from escaping measurement while keeping
  genuinely conditional recovery bytes explicit;
- prove the active cutover has one backend service and no store/UI writer: local typed handlers must
  be present before runtime startup completes, both production roots must defer to the same composed
  service, and broad full-state saves must reject changed protected notes atomically;
- keep `electron/remote/task-notes-http.test.ts` as the table-driven owner for direct Notes wire
  envelopes, exact 400/401/403/409/413/415/429/500/503 status mapping, retry advice, and safe
  gateway/HTTP-edge normalization. Exercise that adapter through
  `electron/remote/remote-command-http.test.ts`, validate the direct body and status together in
  `src/remote/remote-ipc.test.ts`, and retain one real HTTPS assertion in each of
  `electron/remote/server.test.ts` and `server/browser-server.test.ts`. Generic catalog/creation
  commands must remain on their existing outer gateway envelope;
- cover both scoped websocket compositions with content-free invalidation, `notes:read` grant
  filtering, subscriber cleanup, and mounted-only reconnect refetch. Keep the exact Electron-hosted
  integration proof for remote save -> `state.json` -> renderer plus remote event, stale full-save
  rejection, active-mutation drain, new-mutation rejection, and read-only resync during drain;
- treat `scripts/task-notes-proof-seed.json` as the reviewed ownership/command specification and
  `scripts/task-notes-proof-manifest.mjs` as the release freshness owner. Generate a source snapshot
  before the exact command list, require byte-identical source/toolchain state afterward, bind the
  successful command evidence and built artifact into the external report, and verify that same
  report again at promotion. Relevant dirty/untracked input, unresolved dynamic dependency, failed
  command, or any tree/edge/fixture/toolchain/artifact mismatch fails closed; commit ancestry never
  substitutes for those digests.

The proof report lives outside the candidate tree to avoid self-reference. The proof owner uses this
three-phase lifecycle, with `task-notes-command-evidence.json` containing exactly the seed's ordered
commands as `{ "command": string, "exitCode": 0 }` records generated by the external runner:

```sh
node scripts/task-notes-proof-manifest.mjs --candidate HEAD \
  --write-snapshot "$RUNNER_TEMP/task-notes-pre.json"
# Run every command in scripts/task-notes-proof-seed.json, in order, against this clean tree.
node scripts/task-notes-proof-manifest.mjs --candidate HEAD \
  --write-report "$RUNNER_TEMP/task-notes-proof.json" \
  --pre-snapshot "$RUNNER_TEMP/task-notes-pre.json" \
  --command-evidence "$RUNNER_TEMP/task-notes-command-evidence.json" \
  --writer-train desktop \
  --promotion-artifact "release/Parallel-Code.dmg"
node scripts/task-notes-proof-manifest.mjs --candidate HEAD \
  --verify-report "$RUNNER_TEMP/task-notes-proof.json"
```

Use the actual runner-produced relative path in place of `release/Parallel-Code.dmg`, and use
`--writer-train remote` in a separate complete run for the remote train. The in-tree command manifest
runs the full release build immediately before package verification. A writer report requires at
least one approved top-level distributable (`.dmg`, `.AppImage`, `.deb`, `.exe`, `.msi`, `.pkg`,
`.rpm`, `.snap`, or `.zip`) or canonical `release/**/resources/app.asar`; `app.asar` proves the
unpacked application payload, not an installer. Report creation and verification hash exact regular
file bytes, reject unrelated/deceptive names, path escape, non-files, and symlinks in any path
component, and verification rehashes the report-listed paths. A report without an explicit promoted
train remains `dark` and cannot mint a desktop or remote entitlement.

The isolated external runner is the provenance/attestation boundary for both command evidence and
promotion-artifact selection. It must start from a clean release workspace, capture the release
inventory immediately after the final build and package-verification command, permit no intervening
writes, and select every `--promotion-artifact` path from that captured inventory. The manifest
validates the approved path class and rehashes the exact selected bytes; it does not infer which
process created a file from its suffix and does not parse platform-specific installer containers.

The current production entrypoints intentionally compose the default-dark entitlement: only an
external clean-tree runner may archive a successful train report, independently verify the promotion
identity, and pass the resulting immutable entitlement into the matching composition. Repository
dirtiness, a report for the other surface, unequal identities, or a structurally forged entitlement
fails closed. Exact terminal replay and recovery of an operation admitted before rollback remain
available while Issue and first-Update admission are withdrawn.

For renderer Git-action capability work:

- exhaustively prove every merge/push denial reason, deterministic precedence, and managed/imported
  worktree allowance in the pure app owner
- add one thin test per intent surface: shortcuts ignore key repeat, title clicks route through the
  owner, pending dialog consumption revalidates churn, and final workflows acquire no lease or
  backend command after denial
- assert reason codes independently from copy and assert side effects independently from the pure
  evaluator; a denied intent produces one warning and no pending action
- keep one browser accessibility journey for a shortcut denial: the live-region message is
  announced once and focus stays where the user was working
- retain the synchronous 10,000-sample p95 budget and production compressed-bundle comparison; the
  evaluator must add no IPC, timer, dependency, or reactive effect

For app-wide focus and reduced-motion work:

- pair source contracts with real Chromium evidence: source tests own the complete low-specificity
  selector, suppression inventory, vendor wrappers, forced-colors fallbacks, and named motion list;
  the browser owns keyboard-versus-pointer modality and computed output
- seed new panel/row appearance from one current `matchMedia` read, then prove exact root
  `animationend` and `animationcancel` cleanup, nested-event rejection, removal precedence, and no
  stale replay when preferences change
- test reduced motion by computed animation, transition, and outline values rather than by media
  query alone. Nonessential named animations must stop, static status/terminal cues must remain,
  and `.inline-spinner` must keep rotating with adjacent visible or screen-reader progress text
- exercise the main, remote, and Arena stylesheet boundaries separately. Desktop CSS presence does
  not prove remote or Arena focus/forced-color behavior, and component mocks do not prove
  `:focus-visible` modality
- keep built-in focus and static-status colors in the executable theme contrast matrix, including
  every adjacent shell/panel surface where the cue can appear

For coordinator-mode work:

- keep run, credential, prompt, landing, and cleanup proof in `node / backend` tests
- prove server-state bootstrap and `coordinator-event` replay through the existing bootstrap
  category seam
- prove prompt delivery against backend supervision and task-command leases; mounted terminals or
  `PromptInput` should not be required
- prove seeded initial assignment separately from readiness-gated follow-up prompt delivery
- prove Codex readiness detection from captured visible-tail fixtures instead of only shell prompts
- prove direct and scheduled prompt delivery cannot interleave writes to the same target task
- prove prompt-delivery admission caps against queued sweep retries and direct multi-target sends;
  counting must be per active target delivery chain rather than per queued request
- prove prompts block cleanly on `awaiting-input` and fail cleanly if task-command control is lost
  mid-write
- prove the prompt-delivery machine (serialization, admission caps, readiness gating,
  `awaiting-input` blocking, mid-write lease loss, dedupe/bounds) at the module seam in
  `electron/coordinator/prompt-delivery.test.ts`; tool-gateway tests keep thin
  `send_prompt`/spawn/cleanup integration locks over the composed runtime
- prove coordinator inspection tools cap output/diff payloads and reject non-git diffs for non-git
  runs
- prove renderer coordinator actions do not expose bearer tokens, reject peer clients, and require
  currently held task-command leases for mutating actions
- prove coordinator workflows at the backend seam: `spawn_many`, `start_workflow`, subtask-owned
  `submit_result`, subtask-owned `append_workflow_steps`, constrained `steps[]` spec rejection,
  append-only graph mutation, decision-lane `metadata.workflowActions`, append idempotency, lane
  ownership checks, DAG dependency advancement, partial lane failures, scheduled
  retry/timeout/cancel policy, typed verifier verdicts, join-policy fan-in (`all`, `any`,
  `first-success`, `quorum`), impossible verifier threshold rejection, branch-bundle iteration
  limits, cleanup propagation, and stale workflow restore
- prove per-workflow budget enforcement at the backend seam: above-cap budget policy rejection at
  the tool boundary, lowered-budget rejection of starts/appends/decision actions with no state
  mutation, committed-lane counting through the single lane-admission authority, provenance-aware
  retry suppression with one `workflow-budget-exhausted` journal entry (including legacy lanes
  without `spawnedBy` and a zero retry budget), wall-clock trips to `blocked` with the typed
  reason, trip idempotence across repeated ticks, completed-workflow late-append rejection without
  a trip, exactly-at-limit admission boundaries, resume-past-deadline extension by the stale gap,
  and at least one browserless e2e budget-trip scenario (blocked workflow, typed reason, further
  appends rejected, journal kind present)
- prove compact coordinator UI projections in app/Solid tests before relying on browser canaries
  including workflow activity, append and expansion activity, failed/blocked reasons, completion
  reasons, retry/timeout/skipped counts, result previews, join progress, verdict counts,
  pause/unpause controls, pending-approval attention with legal-action gating, manual-retry lane
  projection, and exact operator journal-kind tones
- prove spawn rollback, duplicate-spawn dedupe, custom agent launch propagation, prompt
  close-before-delivery cancellation, seeded-start versus prompt-delivered startup contracts,
  follow-up rejection for disallowed subtasks, credential revocation, restored stale runs, and
  landing cleanup before relying on browser canaries; parent-deadline tests must also prove that a
  late task-create remains shutdown-owned through rollback; shutdown tests must also hold a real
  prompt delivery, scheduler retry, agent call, and renderer call in flight, prove new calls are
  rejected while remembered read-only replays remain available, and prove every admitted call is
  drained through its persisted result-ledger write before teardown takes an unconditional final
  current-state snapshot behind every older write. Exercise the shared producer seam through direct
  run creation/activity and final task deletion/state-removing cleanup as well as tool calls, and
  reject a request carrying an older browser-server lifecycle after an in-process restart. Prove a
  remembered read-only result survives a shutdown with no dirty event and a final-save failure
  rejects cleanup. Transactional loader
  initialization releases every owner acquired before a later failure, and synchronous
  browser-server cleanup followed by an immediate in-process replacement reaches coordinator
  readiness with a live persistence owner. The failure complement must prove that rollback or
  runtime cleanup rejection keeps the ownership turn unreleased, rejects replacement admission,
  reaches the labeled browser cleanup aggregate, and selects a nonzero shutdown exit. Browser
  cleanup tests must also hold one owner open after another rejects, then verify the public wait
  rejects with all labeled failures and signal-driven shutdown selects a nonzero exit only after
  every owner settles
- prove operator controls at the backend seam: per-action run-status and lease authorization for
  the operator-action rule table (`resume_run`, `pause_run`, `unpause_run`,
  `approve_workflow_actions`, `deny_workflow_actions`, `retry_lane`) with structural rejection of
  operator names on the agent tool path, pause admission across every seam (the prompt-delivery
  run-status hook in `electron/coordinator/prompt-delivery.test.ts`, executor reconcile deferral
  with lane timeouts still firing, agent spawn/prompt/append rejection while inspection and
  in-flight completions stay accepted), the approval lifecycle (gated submit holds the lane
  without a result, approve re-validates against the current graph, deny discards with a journaled
  reason, close-out and restore cancel pending approvals, resume re-records them), and manual lane
  retry outside the auto-retry counter but inside the effective lane caps with shared dedupe keys;
  keep the approval round-trip, deny path, pause/unpause prompt flow, and budget-bounded
  `retry_lane` scenarios in the browserless coordinator e2e lane
- prove coordinator resume at the backend seam: stale restore followed by `resume_run` must show
  respawn idempotency (same `requestId` replays the remembered result, a second resume is
  rejected, deterministic `:resume:` dedupe keys cannot double-spawn replacement lanes, and a
  remembered-result replay still requires the held task-command lease), cached-fact replay for
  completed lanes/results/verdicts/expansions, stage completion after a never-spawned lane's
  replacement submits its result, per-workflow resume failure isolation that still records the
  `resumes[]` outcome, credential rotation that invalidates the old subtask token, readiness-gated
  respawns receiving a fresh initial assignment even when the pre-restart prompt had already been
  delivered, and respawn clocks refreshed outside the retry budget; keep the restart-then-resume
  scenario in the browserless coordinator e2e lane
- run `npm run test:node:coordinator:e2e` when coordinator changes cross browser-server HTTP IPC,
  `/api/coordinator/tool-call`, websocket replay, workflow spec execution, adaptive workflow
  appends, decision-lane workflow actions, prompt delivery, or restart/resume/persistence seams
- when coordinator workflow changes are meant to improve real repo work, turn at least one actual
  repo-review or regression-hunt scenario into either a browser-less fixture or a reproducible
  empirical harness under `tmp/` so the proving loop is grounded in real operator work instead of
  only synthetic DAGs
- `npm run test:node` includes the coordinator E2E lane separately, with file parallelism disabled
  for that harness
- prove custom terminal agent parsing and env propagation with owner-local parser/spawn-config tests
- keep browser canaries for browser UI creation, rendering, and client-runtime behavior that cannot
  be proven by browser-less route tests
- do not enable coordinator mode for Electron-only or Docker-runner paths without separate gateway
  and credential-mount proof

For terminal clipboard-image and shortcut work:

- keep native clipboard-image save proof in `node / backend` at the handler/transport seam
- keep terminal shortcut policy proof in owner-local tests for `src/lib/terminal-shortcuts.ts`
- keep final paste/send/suppression proof in `Solid / UI` at the terminal-session seam
- do not rely on broad terminal integration runs alone for terminal-specific shortcut or clipboard
  regressions

For arena competitor preflight:

- keep command availability, auth/env readiness, and quiet-output classification in `node / backend`
  through `electron/ipc/arena-competitors.ts`
- keep the shared direct-executable parser/materializer contract owner-local in
  `src/arena/command-template.ts`; preflight and battle execution must both use that same model
- explicitly prove that shell wrappers and env-prefixed commands are rejected before `Fight!`, and
  that battle materialization stays on direct executable launch instead of drifting to `/bin/sh -c`
- keep `Fight!` gating, per-competitor readiness rendering, and battle-surface warning rendering in
  `Solid / UI` at the arena screen seam
- do not treat a blind arena launch as proof of local CLI availability or authentication; preflight
  must fail the invalid competitor before battle start

For browser startup architecture:

- keep cold bootstrap payload shape and bootstrap-category hydration in `node / backend`
- keep startup-mode and startup-tier policy in owner-local runtime/app tests
- keep the typed browser cold-bootstrap projection owner-local; do not route cold-start proof
  through persisted-workspace JSON parsing tests
- keep selected-terminal-first attach proof in scheduler or terminal owner-local tests
- keep the shell/non-shell startup attach split explicit: visible non-shell startup attach must prove
  `GetTerminalStartupRecoveryBatch`, visible shell attach must prove ordinary attach with
  rendered-tail suppression, and hidden attach must remain ordinary attach
- treat the large-history shell browser cases in
  `tests/browser/terminal-restore.spec.ts` as the maintenance-critical proof for that attach split;
  do not sign off the policy from startup metrics alone
- use browser/runtime integration only when the change crosses cold bootstrap, reconnect restore,
  and terminal continuity seams together
- do not treat reconnect restore tests alone as proof of cold browser startup behavior
- use [tests/browser/browser-startup-metrics.spec.ts](../tests/browser/browser-startup-metrics.spec.ts)
  when a change needs real browser cold-start timing evidence
- the startup-metrics spec owns the asserted TTI budgets on its gated lane
  (`npm run benchmark:browser:startup-metrics`, which sets `RUN_BROWSER_STARTUP_METRICS=1`; run it
  on the benchmark runner with the machine otherwise idle):
  selected-terminal queued-to-interactive (attach trace `attachQueuedAtMs` to `readyAtMs`) of
  250ms / 350ms / 800ms for the 1 / 8 / 24-terminal fixtures, and reconnect `restoreTotalMs` of
  500ms on the interactive-node fixture; the steady-state spec owns the echo p95 bar. Budget
  re-baselines require an explicit note here: the 24-terminal bar was set to 800ms (plan target
  500ms) because the cold fixture pays a real fresh PTY spawn during a 24-task cold bootstrap
  (~590-615ms measured locally), not an attach-to-existing
- the attach pipeline's deterministic CI bars live in node/runtime tests: exactly one backend
  round trip per attach (`terminal-session.test.tsx`), zero per-terminal pause/resume invokes
  during batched restores (`terminal-recovery-runtime.test.tsx`), no serial collapse with a
  pending foreground candidate plus the 24-terminal dispatch-release queue span
  (`npm run benchmark:terminal:attach-recovery`)
- record captures and comparisons in
  [BROWSER-BOOTSTRAP-METRICS-2026-04-03.md](./BROWSER-BOOTSTRAP-METRICS-2026-04-03.md)
- server boot-pipeline changes are proven by `server/boot-pipeline.test.ts` ordering and count
  assertions (bounded `gitSubprocessCount` at listen, hydrated cold-bootstrap categories,
  focus-priority refresh ordering, the no-retry coordinator first call), never by wall-clock
  budgets; the wall-clock numbers belong to the `npm run profile:server:boot` lab scorecard
  recorded in the metrics doc
- the cold-bootstrap handler must stay structurally free of process spawns and probing: the
  hung-prober test in `electron/ipc/system-handlers.test.ts` (command-resolver/hydra probers
  mocked to never resolve) is the guard, with sticky-availability and probe-scheduling semantics
  proven at the owner seam in `electron/ipc/agent-availability-state.test.ts`
- the browser startup critical path is guarded by the recording-invoke round-trip test in
  `src/app/desktop-session.test.ts`: exactly one awaited network fetch (the cold bootstrap)
  before the selected-task tier, with plan content and project-path existence applied
  payload-only and speculation resolved before the tier is announced; do not assert specific
  attach RPC names there — attach happens after the tier and its channel name belongs to the
  attach-pipeline owner
- reconnect payload assertions are value-identity of fields where present, never whole-payload
  byte identity: the revision-keyed skip legitimately omits `workspaceStateJson`/`appStateJson`,
  and the no-change path must still prove reconciliation side effects run (review rule 2)
- derived-state hydration counts as a startup/persistence change: legacy, partial, and corrupt
  persisted fragments are implicitly part of the proof (`derived-state-persistence.test.ts`,
  `saved-state-restore.test.ts`), and hydration must stay behind exact identity filters
- moving work behind the post-listen coordinator runtime loader must keep the coordinator
  browserless e2e green through awaited readiness at every coordinator entry point, not through
  client-side retry loops

For perceived-latency presentation work:

- prove the startup-skeleton/false-empty-state contract at the projection seam first
  (`TilingLayout.test.tsx`: skeleton while presentation is pending with a cached shape, onboarding
  only for genuinely-first-run users, deterministic enter/exit churn), with one spec-locked
  browser case (`tests/browser/startup-skeleton.spec.ts`) whose DOM-text history capture proves
  the first-run copy never persists during a real reload and that skeleton-to-real-columns has no
  intermediate zero-column frame
- prove pre-session input buffering at the owner seam
  (`terminal-pending-session-input.test.tsx`: order, byte cap, drain TTL, reactive count, cleanup)
  plus `TerminalView.test.tsx` flush-ordering into `session.handleTerminalData`; keep exactly one
  browser lock (`tests/browser/terminal-preready-input.spec.ts`) asserting the typed marker
  reaches backend scrollback exactly once — never assert queued-indicator visibility in the
  browser, the window is timing-fragile once attach is one round trip
- prove optimistic task creation at the workflow owner seam (`task-creation-optimism.test.ts`:
  success removal, error+retry, dismiss, the never-in-store invariant); dialog and column
  component tests stay thin integration checks
- prove coordinator attention projections in app tests (`task-presentation-status.test.ts`
  exercising the compact `coordinator-attention.ts` projection) before any browser canary;
  rail/title-bar affordances are Solid component proofs (`TaskCoordinatorSection.test.tsx`,
  `TaskTitleBar.test.tsx`) with fake-time coverage for the spawn-ack window; inspector tests must
  also hold responses across target/run switches, overlapping actions, and unmount so stale
  completions cannot replace current content or clear a newer busy owner
- time-windowed feedback introduced by this layer (spawn-ack chip, persistent error toasts,
  pending-input TTL) follows the standing fake-time rule: at least one test advances the clock
  without unrelated store changes

## Required Versus Exploratory Validation

Not every terminal-performance tool belongs in the default review gate.

Use this split:

- required product proof:
  - targeted `node / backend`, `runtime / integration`, and `Solid / UI` tests for the changed
    owner seam
  - the default `npm run test:node` lane runs `server/terminal-latency.test.ts`,
    `server/session-stress.test.ts`, `server/boot-pipeline.test.ts`,
    `tests/contracts/review-diff.contract.test.ts`, and
    `tests/harness/standalone-server.test.ts` through the mandatory serial
    server-integration owner. The public `test:node:server-integration` command prepares fresh
    browser artifacts before delegating to `test:node:server-integration:run`; the parent
    `test:node` aggregate prepares once and calls that inner lane directly. Coordinator browser-less
    E2E keeps its separate serial owner. Keep strict latency, live WebSocket stress assertions,
    built-standalone route harnesses, and coordinator E2E out of the broad Vitest worker pool.
    Direct harness, contract, lifecycle, and reliability aggregates that include built-standalone
    owners must prepare fresh artifacts once, then delegate to a serial build-free inner lane so
    reuse from a prepared aggregate cannot duplicate builds
  - checked-in micro-performance and compressed-bundle budgets run through the serial
    `test:performance-gates` owner after a fresh browser-artifact build. The broad Node worker pool
    excludes those files so unrelated CPU contention cannot turn an owner-local p95/p99 budget into
    a flaky regression; `test:node` still invokes the serial gate, so the budgets remain mandatory
    product proof rather than an opt-in benchmark. The validation inventory must cover
    `.bench.test.ts`, `.benchmark.test.ts`, `.performance.test.ts`, bundle budgets, and the named
    mandatory `.benchmark.ts` files from `vitest.benchmark.config.ts`; every gate has exactly one
    mandatory owner
  - bundle attribution and final-app regression are different measurements. Preserve a feature's
    isolated before/after result as historical evidence, and measure a lazy feature's emitted chunk
    or import closure when the build graph exposes one. Never subtract an old feature baseline from
    a final bundle that contains later eager features. After features are combined, fresh artifacts
    use one explicit post-integration baseline plus a bounded drift budget and the strict absolute
    ceiling; changing that baseline requires recording the reason and exact toolchain
  - the scripted browser terminal matrix when terminal runtime behavior changed
  - the focused browser stress spec when continuity, resize, startup, or noisy-output behavior
    changed
  - the deterministic render-stress case in `tests/browser/terminal-render-stress.spec.ts`
  - the real Docker integration lane for task-container runtime work:
    - `npm run test:node:docker:integration`
    - use `npm run test:node:docker:integration:required` when pre-release proof must fail if
      Docker or Compose is unavailable
    - required when `electron/ipc/task-containers.ts`, `electron/ipc/task-container-identity.ts`,
      or task-container preview derivation / cleanup semantics change
  - the real Docker integration lane for agent-runner execution:
    - `npm run test:node:docker:agent-runner`
    - use `npm run test:node:docker:agent-runner:required` when pre-release proof must fail if
      Docker is unavailable
    - required when `electron/ipc/agent-runner-docker.ts`,
      `electron/ipc/task-workflows.ts` runner wrapping, or runner cleanup semantics change
  - the non-browser multi-agent terminal stress lane:
    - `npm run test:node:terminal:stress`
    - required when task AI terminal layout, selected/passive command-target projection, or
      visible terminal role assignment changes
- exploratory perf-lab proof:
  - variant matrices
  - browser fluidity profilers
  - steady-state microbenchmarks
  - manual benchmark/spec entrypoints whose purpose is comparison, not release gating
  - the long additive-output soak in `tests/browser/terminal-render-soak.spec.ts`

Profiler and benchmark scripts are support tooling. They are useful for diagnosing or comparing
performance candidates, but they should not expand the default PR gate unless the change is about
terminal performance and the chosen script is part of the documented release recipe.

Dependency and toolchain changes use a separate, exposure-aware proof stack:

- Run installs with the exact `packageManager` npm version. It recognizes the project
  `strict-allow-scripts` setting and applies the reviewed `package.json#allowScripts` identities;
  an older npm used only to bootstrap that pinned CLI may warn about the newer setting, but must
  never run `npm ci` or count as install-policy evidence.
- Keep lock classification and audit-policy fixtures network-independent in the validation-guard
  lane. Every installed node must be reachable from a declared root; unknown audit nodes, lock
  shapes, severities, and runtime imports fail closed.
- After a clean `npm ci`, the live audit is release truth: critical/high findings block every lane,
  while moderate findings also block backend-runtime and renderer-shipped closures. A valid
  vulnerability result is not a retryable transport failure.
- Change direct owners in coherent runtime/packaging, renderer, and build/test lanes. Inspect the
  regenerated npm-owned lock with `npm ls --all`, then run the behavior seams controlled by those
  owners; an audit count alone does not prove compatibility.
- Capture dependency resource baselines and targets with the same scorecard runner, exact Node/npm,
  machine, protocol, and at least three samples. Missing, stale, non-reproducible, or mismatched
  artifacts are failed evidence, not permission to skip a budget. The baseline may remain the
  historical comparison point, but the default compare command hashes the current `package.json`
  and `package-lock.json` and rejects a target captured from any other dependency inputs; recapture
  the target only after those inputs are frozen.
- CI proves the explicit minimum supported Node line; the full quality and release lanes prove the
  pinned current LTS line. Floating `lts/*` is not evidence for the documented minimum.

Keep the deterministic terminal lane and the soak lane separate. The deterministic lane covers the
user-visible regression contract. The soak lane runs in its own Playwright invocation so long
additive-output runs do not contaminate the default review gate.

If one deterministic browser case is only stable on a fresh terminal/browser-lab environment after
the shared lane has already proven the rest of the contract, keep that case in the deterministic
recipe. Run it first in its own Playwright invocation instead of widening timeouts or weakening
assertions.

## State-Machine Coverage

For lifecycle-heavy behavior, the unit of proof is the state machine, not the helper function.

Every risky state machine should have:

- explicit states
- explicit transitions
- explicit invariants
- discriminated-union or exhaustive-record modeling whenever the machine is owned in code
- at least one failure-path test
- at least one recovery-path test when a fallback exists
- explicit stale-result or generation invalidation proof when async completions can race
- explicit coverage for every correctness-relevant invalidation input when cache keys or refresh
  guards are involved
- one runtime/browser scenario when the lifecycle crosses backend plus UI ownership

For lifecycle-heavy work, test invariants as well as transitions:

- every transitional state must have one live owner
- every transitional state must have one deterministic exit
- stale generation or stale transport completions must not mutate current truth
- abortable renderer transport tests cover browser cancellation and an Electron IPC promise that
  remains pending after the consumer has already rejected with the exact abort reason
- a UI that looks input-ready must still prove the send path, controller lease, and transport are
  valid
- paused, flow-controlled, reconnecting, and restoring states must fail once the owning blocker is
  gone
- terminal cursor visibility must follow the same contract as terminal readiness; add focused tests
  when render-hibernation, recovery, or resize deferral can leave the surface visually stale
- terminal render changes should also prove anomaly budgets, not only visible correctness:
  excessive steady-state recovery, repeated viewport refresh, or sustained redraw-control pressure
  should fail the relevant stress seam even if the terminal never fully crashes
- paint-only WebGL recovery needs both owner-state proof (platform edge, generation, priority,
  dedupe, one-per-frame drain, failure isolation, listener cleanup) and real-browser cause/effect
  proof. A DOM-only lane must assert zero queued/applied work, and remote restore repaint tests must
  prove refresh occurs after the final buffered write while stale/disconnect/live-output paths stay
  at zero.
- optional terminal-search addon work needs an idle-zero browser proof: no addon request, instance,
  listener, or search call before the first nonempty query or after overlay/session cleanup. Pair it
  with deterministic scan/next/previous latency, query/result caps, stale-generation suppression,
  and byte-isolation proof so a local presentation capability cannot drift into PTY or transport
  behavior.
- when a render or lifecycle issue needs a smoke artifact, capture the composite terminal
  diagnostics bundle first so anomaly, output, runtime, and lifecycle evidence stay together
- task and standalone-terminal close flows need proof that renderer state is removed immediately
  after runtime cleanup, that removal is persisted best-effort, and that partial backend cleanup
  failures surface as warnings instead of leaving stale `closing`, `removing`, or `restoring` state
- terminal remount/teardown changes need proof that stale callbacks from the old session cannot
  clear the current focus callback, readiness state, or input feedback state
- bounded request-process tests must prove cancellation keeps consuming admission until cleanup
  settles, repeated request ids cannot bypass the global owner cap, and both runtime shells drain
  every request; desktop and browser cleanup tests must wait for independent owners and map any
  labeled aggregate failure to a nonzero process exit
- every consumer that treats requested subprocess termination as expected must also prove an
  unconfirmed forced settlement remains a failure; fallback paths may proceed only after the shared
  bounded owner confirms process-tree release
- profiler lifecycle tests include successful measurement plus failed cleanup, not only operation
  failure plus cleanup, so a pending `return` cannot silently erase cleanup errors; include a
  non-`Error` rejection such as `undefined` or `null` anywhere outcome staging could confuse a
  rejection reason with the no-failure sentinel
- independent cleanup batches must start and settle every owner before rejecting, preserve stable
  owner labels, and retain simultaneous or non-`Error` failures instead of exposing only the first
- browser-server lifecycle tests must await `BrowserServerController.whenReady()` before direct
  HTTP/websocket access, prove activation failure rejects readiness without opening a port, and
  prove the production entry point awaits the same contract. Startup bootstrap assertions should
  consume authoritative `state-bootstrap` categories when compacted control replay can correctly
  degrade to `replay-truncated`
- file-lock fault matrices must cover acquisition directory-fsync ambiguity and release failures at
  exact-token read, unlink, and parent-directory fsync. After every failed release, assert the same
  owner can retry from the retained phase and an in-process replacement cannot acquire early; test
  workspace storage and the shared sharded-operation journal owner, not only one consumer
- session-stress client acquisition tests must prove concurrent connect and bind attempts all settle
  before cleanup snapshots ownership, every authenticated client is owned before later bind or
  restore work, and failed pre-authentication sockets terminate without retaining startup listeners;
  a socket teardown failure must remain visible alongside the connection failure

When manual testing finds a new stuck state, the fix is not complete until the suite has:

- one owner-local deterministic churn test
- one cross-owner runtime or browser scenario if the state is user-visible
- one reusable invariant assertion or failure artifact when the same class can recur elsewhere

For many-terminal performance work, move from specialized harnesses to browser proof:

- prove the likely hot owner first with a focused runtime or steady-state harness
- measure backend or session pressure separately instead of assuming the same bottleneck
- use the browser as the final confirmation layer, not the first debugging loop
- keep one explicit baseline, sweep the relevant visible-set shapes when layout matters, and do not
  promote a candidate on one metric alone
- if the change introduces an opt-in or heavy-load mode, validate both the shipped default path and
  the opt-in path at the layouts they affect
- when hidden-terminal lifecycle is under review, distinguish cold wake from recent hidden switch
  instead of treating them as interchangeable
- keep packaged profiler entrypoints aligned with the documented browser gate
- keep exploratory browser-profiler commands explicitly labeled under `lab:*`
- keep profiler and browser-gate readiness checks aligned with the runtime's structural loading
  contract instead of visible loading copy
- when task-scoped terminal state is owned above `TerminalView`, add one focused task-level test so
  sibling mounts and unmounts cannot silently interfere with shared task protection
- when a terminal restore test overlaps panel resizing with reload or recovery, prove a real
  post-restore resize after the terminal is interactive before asserting resize diagnostics; resize
  attempts while the surface is still masked may be correctness pressure without producing render
  counters
- match browser fixture lifetime to the asserted journey: `createPromptReadyScenario()` exits after
  its startup frames. Reload or reconnect scenarios that require the seeded agent to remain ready,
  including whole-page terminal anomaly checks, must use `createPersistentPromptReadyScenario()`
  or another long-lived fixture. Keep finite fixtures for startup-only output proof; never restore
  an exited managed agent automatically or weaken readiness assertions to compensate for fixture
  exit. `tests/harness/prompt-ready-fixture.test.ts` exercises both scenario factories against real
  processes.
- when a browser-lab render test needs diagnostics or lifecycle capture, route it through the
  shared harness `openSession(...)` path instead of raw `browser.newContext()` so teardown and
  artifact capture stay unified
- when a browser render test needs anomaly or fluidity budgets, use the shared diagnostics-capture
  helpers instead of stitching raw renderer/output counters together ad hoc
- when startup architecture changes, keep the browser startup experiment practical and role-aware:
  prefer the default visible-startup matrix (`default-1-shell`, `default-2-shells`,
  `compact-3-shells`, `default-4-shells`) and read the returned recovery-kind counts before
  trusting a "green" run. A startup change is not proven if the benchmark self-saturates before
  reload or if visible startup silently falls back to legacy delta-heavy recovery.
- when steady-state typing priority changes, prove it at three seams:
  - owner-local unit/runtime tests for the typing-priority owner
  - browser noisy-background and visible-sibling responsiveness lanes
  - one isolated rerun of any marginal browser failure before retuning policy, so suite-order
    variance does not masquerade as a real latency regression

Generated browser-lab output is not review surface:

- profiler, matrix, and stress artifacts under `artifacts/` are disposable local evidence
- do not include those outputs in code review or treat them as part of the product diff
- if a result matters long term, summarize the conclusion in docs and keep the artifact path out of
  the main review stack

The current required state-machine set is:

1. Review and diff lifecycle
   - states:
     - `worktree`
     - `branch-fallback`
     - `worktree-restored`
     - `committed`
     - `uncommitted`
     - `added`
     - `modified`
     - `deleted`
     - `binary`
   - required transitions:
     - worktree diff -> branch fallback when worktree diff is unavailable
     - branch fallback -> worktree when the worktree returns
     - same path -> different committed/status semantics after refresh
     - branch head changes
     - main/base head changes
     - stale status hint -> canonical backend diff truth
   - owner:
     - backend for git truth
     - workflow / app for source selection
     - presentation for selected-file continuity
   - seams:
     - `node / backend`
     - `Solid / UI`
     - one `runtime / integration` review-flow scenario
2. Task lifecycle and cleanup
   - states:
     - `active`
     - `closing`
     - `collapsed`
     - `cleanup-requested`
     - `cleanup-failed`
     - `removed`
   - required transitions:
     - create agent task -> exactly one AI runtime and no implicit shell
     - create terminal task -> exactly one task-scoped shell and no AI runtime
     - active -> closing -> removed
     - active -> collapsed
     - collapsed agent/terminal task -> canonical session identity restored with an authorized next
       generation and restarted task watchers, including repeated same-host cycles and restart
     - failed collapse stop/permit persistence -> reopen retries suspension before admitting attach;
       shutdown drains admitted transitions before journal disposal
     - collapsed load/save -> exact canonical IDs retained; old erased-ID snapshots stay collapsed
       with explicit recovery guidance instead of inventing session authority
     - cleanup failure -> retained task with visible error state
     - worktree missing during cleanup
     - lease-valid -> lease-lost during destructive action
     - concurrent canonical project-root admission -> memberships coexist without checkout mutation;
       merge is rejected before mutation while any membership remains, and lagging saved snapshots
       neither free live roots nor resurrect removals
     - legacy saved worktree subdirectory -> canonical registry owner without collapsing a nested
       worktree root or mapping a missing worktree onto its ancestor checkout
     - response lost after task creation commit -> retry with the same operation id replays the
       original task result without repeating checkout, worktree creation, or runtime registration
   - owner:
     - workflow / app
     - backend runtime cleanup seams
   - seams:
     - `node / backend`
     - `runtime / integration` when observers/watchers or browser-owned state are involved
3. Terminal lifecycle and recovery
   - states:
     - `spawned`
     - `attached`
     - `focused`
     - `unfocused`
     - `backpressured`
     - `recovery-required`
     - `replaying`
     - `restored`
     - `exited`
   - required transitions:
     - spawn -> attach -> detach -> reattach
     - focused output -> unfocused output -> focused output
     - live output during recovery
     - backpressure -> recovery
     - redraw-heavy burst -> paced render without byte loss
   - owner:
     - backend terminal truth
     - renderer pacing/recovery owners
   - seams:
     - `node / backend`
     - `Solid / UI`
     - `runtime / integration`
   - invariant stress additions:
     - no visible terminal may remain `restoring`, `binding`, `attaching`, `flow-controlled`, or
       input-blocked once the owning blocker settles
     - browser stress should assert operational readiness, not only visible prompt text
4. Task container lifecycle
   - states:
     - `not_configured`
     - `unsupported`
     - `ready`
     - `running`
     - `error`
   - required transitions:
     - worktree with no supported Compose file -> `not_configured`
     - supported Compose file + unsupported shape -> `unsupported`
     - supported Compose file + healthy inspect -> `ready`
     - `ready` -> `running` after start
     - `running` -> `ready` after stop
     - Compose status failure -> `error`
     - log load from a configured project returns stable task-scoped output
   - owner:
     - backend for identity, inspect, planning, Docker Compose execution, and logs
     - handler / transport for typed IPC validation
     - workflow / app for preview-manager refresh/polling policy
     - presentation for status, actions, and log rendering
   - seams:
     - `node / backend` for compose-file selection, unsupported reasons, env-file resolution,
       identity, start/stop/destroy/log semantics
     - `Solid / UI` for preview-manager rendering and action wiring
     - `runtime / integration` only when browser preview routing or container polling behavior
       changes
   - real-runtime additions:
     - mocked backend proof is not enough once Docker lifecycle or identity behavior changes
     - keep the opt-in Docker integration suite green for:
       - real Compose inspect/start/stop/destroy/logs
       - fixed-port conflict handling
       - unsupported compose-shape detection from real config output
       - same-project multi-worktree identity isolation
     - keep mocked deletion-cleanup fault injection for Docker availability and label cleanup that
       never settle; both must reject at the owner deadline so task deletion can continue with a
       typed cleanup warning
5. Multi-client control and lease lifecycle
   - states:
     - `unowned`
     - `leased`
     - `expired`
     - `contested`
     - `takeover-requested`
     - `takeover-approved`
     - `takeover-denied`
   - required transitions:
     - acquire -> renew -> release
     - acquire -> expiry
     - leased -> takeover requested
     - owner disconnect -> retained state cleared
   - owner:
     - backend/controller truth
     - workflow / app takeover surfaces
   - seams:
     - `node / backend`
     - `runtime / integration`
   - invariant stress additions:
     - pre-approval read-only paths must reject input without mutating scrollback
     - ownership churn must not leave stale controller, stale read-only UI, or stale queued input
6. Startup, persistence, and reconciliation
   - states:
     - `cold-start`
     - `bootstrap-loading`
     - `bootstrap-reconciled`
     - `partial-persisted`
     - `corrupt-persisted`
     - `stale-repaired`
   - required transitions:
     - persisted input -> repaired state
     - bootstrap in flight -> reconnect
     - cleanup during bootstrap
     - shared state restore -> local-only state preserved
   - owner:
     - backend persistence truth
     - workflow / app bootstrap ordering
     - store / projection repair
   - seams:
     - `node / backend`
     - `runtime / integration`
7. Remote bootstrap and presence lifecycle
   - states:
     - `disconnected`
     - `bootstrapping`
     - `connected`
     - `presence-updated`
     - `renamed`
     - `reconnecting`
     - `stale-removed`
   - required transitions:
     - bootstrap -> presence visible
     - rename -> desktop/mobile reflection
     - reconnect -> consistent identity
     - stale remote session removal
   - owner:
     - backend/server truth
     - workflow / app session handling
     - presentation presence surfaces
   - seams:
     - `node / backend`
     - `runtime / integration`

## Choosing The Right Seam

Use `node / backend` when the risk is:

- handler validation
- transport semantics
- ordering/version truth
- workflow lifecycle
- replay or recovery policy
- persistence parsing and normalization

Use `Solid / UI` when the risk is:

- a high-churn screen flow
- component-level state transitions
- focus, dialog, banner, or inline status behavior inside one renderer surface
- renderer-side runtime owners that depend on repeated Solid signal updates but do not require a
  real browser/server session
- projection-to-UI mapping that does not require a real browser runtime

Use `runtime / integration` when the risk is:

- browser focus or visibility behavior
- terminal readiness, restore, or rendering timing
- real multi-tab or multi-client behavior
- websocket/auth/bootstrap interaction
- stress, fanout, latency, or replay cost

If behavior depends on repeated Solid reactive updates, do not validate it only in the plain node
suite. Use `Solid / UI` so the runtime exercises client-side reactivity instead of server-only
one-pass behavior.

If the UI state is time-windowed rather than event-complete, add at least one fake-time test that
advances the clock without changing unrelated store state. That proves a `Date.now()`-based badge or
label expires because time advanced, not because an unrelated rerender happened.

## Fast Lifecycle Gate Rules

Do not add a new Playwright spec when `node / backend` or `Solid / UI` can prove the same risk
faster.

Prefer browser coverage only when the failure depends on:

- real focus or visibility behavior
- real browser transport/bootstrap behavior
- multi-context coordination
- terminal rendering behavior that only manifests with the real browser runtime

## Scoped Vitest Runs

For targeted Vitest runs, prefer the repo wrapper scripts over raw `npm exec vitest ...`:

- `npm run test:node:file -- <file> [more files...]`
- `npm run test:solid:file -- <file> [more files...]`
- `npm run test:browser:file -- <spec> [more Playwright args...]`
- `npm run test:browser:active-features`

Those wrappers:

- call the direct Vitest entrypoint instead of relying on `npm exec`
- enforce a default `60s` timeout for ad hoc runs
- terminate the spawned Vitest process tree on timeout or shell shutdown
- for `test:solid:file`, run each requested Solid/jsdom file in its own Vitest child so one
  file's globals, timers, or pending reactive cleanup cannot contaminate another file's proof
- for browser Playwright runs, prepare browser artifacts once when they are stale or missing, then
  keep the standalone harness freshness check as a backstop instead of silently testing stale
  bundles
- `test:browser:active-features` is the deterministic, single-worker acceptance owner for the
  currently shipped upstream-catch-up journeys and their browser-observable performance budgets.
  CI and release preflight run it after `npm test`; adding a shipped cross-runtime feature requires
  adding its browser proof here instead of leaving an orphaned ad hoc command. The product-validation
  guard owns the exact 21-spec inventory, rejects duplicates or extras, requires Chromium with one
  worker, and verifies the command appears exactly once after `npm test` in both workflows

Shared-root task acceptance includes `parallel-project-root-tasks.spec.ts`: real creation on a
dirty custom branch with an obsolete project default, subtle shared-location cues, and continued
terminal use after closing a sibling. It also covers repeated agent/terminal collapse and reopen,
active/collapsed reload, exact session identity, and continued sibling process state. Backend proof
additionally covers canonical aliases,
concurrent creation/merge ordering, exact task-command leases, retained watcher/snapshot ownership,
and single-writer checkout-scoped integrations. Browser success alone does not prove those races.

Standalone server integration helpers, profilers, and stress fixtures use the shared
`scripts/lib/standalone-server-process.mjs` owner. Keep both sides of its teardown contract under
direct test: capture POSIX ownership during startup output/readiness so a real uncooperative
descendant in a detached process group remains owned even when its root exits before the first stop
attempt, keep that identity across cleanup retries, and prove it is gone after escalation. Simulated
Windows coverage must prove that even a root which exited before shutdown cannot bypass the awaited
tree-kill request, including bounded forced escalation and helper failure.

You can override the timeout with `VITEST_SCOPED_TIMEOUT_MS=<ms>` or
`--timeout-ms <ms>`.

When a Solid/jsdom test waits through transient loading states, avoid patterns like
`waitFor(() => screen.getByText(...))`. Prefer a non-throwing query inside `waitFor`, or a small
helper built on `screen.queryBy...`, so a stale failure path does not repeatedly serialize the DOM
for thrown query errors.

Keep assertions out of `mockImplementation` and other test-double callbacks. A mock callback may
never run, which can make an important expectation disappear while the test still passes. Let the
double record its calls and return or throw the configured behavior, then assert call count,
arguments, ordering, and captured values from the test body after the workflow completes.

When a UI behavior has a dedicated local owner, prove the state machine at that owner seam first
and keep the leaf-component integration test thin. For example, task-control banner/chip behavior
belongs in `task-control-visual-state`, while `TerminalView` only needs minimal integration proof
that it wires the owner in.

One seam is usually not enough when the change touches:

- browser terminal restore or recovery
- multi-client control and takeover
- startup and persistence ordering
- preview routing across backend plus UI
- shared runtime harnesses

## What Good Coverage Looks Like

Coverage is sufficient when it proves the failure mode that would matter in production.

Examples:

- a handler typing change is sufficiently covered when direct node tests prove exact required and
  optional payload behavior
- a terminal recovery change is sufficiently covered when node tests prove the recovery contract,
  initial-attach pause transfer is acknowledged before deferred readiness while local output stays
  blocked through apply, and browser/runtime tests prove the user does not see destructive restore
  behavior unexpectedly
- a terminal startup performance change is sufficiently covered when browser/runtime tests prove the
  end-to-end completion time and measured hot-path phases changed as intended, not only that a
  lower-level scheduler or recovery helper was called; the strongest completion metric is the
  traced `firstQueuedToLastReadyMs`, not a viewport-dependent shell-visible timestamp alone
- a terminal output pacing or flicker change is sufficiently covered when focused seam tests prove
  byte preservation, split escape-sequence handling, and direct-vs-queued routing behavior, and a
  real browser/runtime terminal workload proves the redraw-heavy case no longer exposes
  intermediate frames; when hidden-terminal behavior is part of the change, validate render wake
  and session wake separately instead of collapsing them into one hidden-switch case, and sweep at
  least one narrower visible-shape profile when the result may depend on how many terminals are in
  view
- a review diff performance change is sufficiently covered when backend tests prove the changed-file
  and per-file diff semantics stayed correct, and the manual review profiler proves cold/warm
  latency moved in the intended direction on a real worktree
- a screen-only layout or banner change is sufficiently covered when Solid tests prove the real
  user-facing transitions
- a sidebar chrome change is sufficiently covered when Solid tests prove the collapse and reopen
  transitions and session-state tests prove the section preference stays local instead of leaking
  into shared workspace persistence
- a store-boundary cleanup is sufficiently covered when architecture tests prove workflow entry
  points moved out of `src/store/*` and the remaining store exceptions are explicitly documented
- a TaskPanel permission-flow split is sufficiently covered when architecture tests prove the
  component uses the named permission controller and Solid tests prove approve/deny behavior still
  resolves through the app-layer workflow
- a ReviewPanel controller split is sufficiently covered when architecture tests prove the component
  no longer owns transport/loading orchestration and Solid tests prove selected-file continuity and
  mode switching still work
- a NewTaskDialog Git-options split is sufficiently covered when the controller tests prove parallel
  managed-worktree reads, stale-response suppression, same-configuration project identity resets,
  close/mode/non-git clearing, backend-default-only selection, truncation, and independent branch and
  candidate retries. Dialog tests must prove candidate loading blocks only managed creation,
  advisory failure retries but still permits empty-selection creation, non-worktree flows issue no
  candidate request, and selected names reach task creation. Backend tests must separately prove
  bounded real-Git discovery, canonical request limits, fresh admission, literal shared-exclude
  handling, destination safety, rollback/postconditions, and typed warning replay; renderer coverage
  cannot substitute for those authority tests
- a startup refactor is sufficiently covered when tests prove ordering, cleanup, reconciliation, and
  stale-state repair, not just that bootstrap functions were called
- a task-steps redesign is sufficiently covered when backend tests prove `.claude/steps.json`
  normalization, timestamp repair, and watcher cleanup, startup/runtime tests prove the
  `task-steps` replay category hydrates before buffered live events, and Solid tests prove the task
  panel section, next-action prefill, and focus/jump affordances still route through the named
  owners instead of inline component logic
- a required-browser-dialog startup change is sufficiently covered when the shared startup summary
  is visible in the dialog while the dialog owns the announcement surface, and the standalone
  startup chip resumes only after that required dialog is gone

Coverage is usually not sufficient when it only proves:

- a helper was called
- a mock received the right arguments
- a polling loop still fires
- a component rendered one static string without proving the state transition behind it

## Failure Patterns That Must Be Validated

### Startup, Persistence, And Reconciliation

Validate these failure patterns:

- startup ordering drops or reorders early pushed events
- cold browser bootstrap silently reuses reconnect restore semantics
- full-state and workspace-state paths drift apart
- stale persisted state is amplified instead of repaired
- no-op sync paths skip required reconciliation side effects
- task removal clears store records but leaves module-local runtime state behind
- local-only session or layout state is accidentally overwritten by shared workspace state
- backend-owned replay categories hydrate after buffered live events and silently drop or reorder
  shared state
- full-state restore clears persisted task records but leaves stale backend-projected task-step
  summaries or full snapshots in the renderer
- workspace write failure is treated as a generic I/O error without rereading the primary and
  comparing the exact prior/proposed generation plus payload digest
- rename succeeds but parent-directory fsync fails, then projection/event/success or a later
  mutation is allowed before exact durability repair
- startup promotes a valid higher temporary or stale backup over a missing/corrupt canonical
  primary, or classifies state before the unconditional containing-directory fsync barrier
- standalone and Electron adapters partition the same logical shared state differently, or Electron
  creates a second canonical workspace file instead of migrating its one `state.json` in place
- a stale full save reaches the mutator/projection before revision conflict, an unchanged mutation
  writes or emits, or a private-only mutation advances the shared revision/event
- a remote canonical replacement silently loses a pending local rename/reorder/project edit, or a
  generic JSON diff overwrites a same-field remote edit
- a pagehide save commits after the next browser page's startup read: a rejected browser save must
  refresh once, preserve pending edits through the canonical rebase, and use the new revision and
  snapshot on the next save; an older refresh must not rewind newer live state

Edge cases that are easy to miss:

- legacy persisted fragments
- corrupt or partial persisted fragments
- grouped client-local preferences require explicit-`false`, per-field malformed-input, detached
  snapshot, older-known-key-writer rollback, and negative shared-workspace proofs; a dialog that
  samples those preferences also needs one-open isolation and submit-time capability-change proof
- coordinator persistence salvage and compaction: one corrupt run drops only that run, an
  unreadable primary falls back to `.bak` (quarantining the corrupt file), a failed load never
  deletes credential files, and save-time compaction strips terminal-run journals/launches under
  the `COORDINATOR_PERSISTENCE_LIMITS` retention caps (`electron/coordinator/persistence.test.ts`)
- background terminal attach resuming before the selected surface is ready
- cleanup before startup fully completes
- workspace-owner recomposition with changed callback identities or storage kind, a pre-supplied
  external host, cross-map reconnect-cache invalidation, first-failure/second-success lazy
  initialization, cleanup after an initialization that produced no service, and cleanup called in
  the same turn as deferred structural initialization
- controller/version state surviving a full-state restore incorrectly
- cleanup authority clearing some task-scoped owners but not others
- canonical uint64 boundaries (`0`, leading zero/sign rejection, max, overflow), canonical payload
  hashing excluding only the digest, and generation-0-to-1 legacy migration
- every temp-write/file-fsync/rename/directory-fsync/lost-response boundary, with exact-prior,
  exact-proposal, and neither-witness outcomes asserted separately
- agent-session journals need the same real-file fault matrix plus component ceilings: active
  records are never evicted, rich responses are independently bounded, compact initial/fallback
  identity survives response eviction, a missing/corrupt primary is never replaced by an older
  valid backup, and an unacknowledged directory fsync authorizes zero next effect until exact repair
- agent-session activation fixtures must cover the dark-to-active boundary, missing/unavailable owner, closing gate,
  cutover-epoch mismatch, hook-version mismatch, and unhealthy journal with zero operation/identity
  mutation, timer, generation allocation, runner cleanup/spawn, or lifecycle publication. Probe,
  drain, and exact-task finalizer tests are separate: probing never activates admission; drain is
  idempotent and retains evidence; finalization requires the matching committed-removal witness
- automatic resume fallback needs captured ANSI/redraw, near-match, final-frame, 16 KiB/50-line,
  exit/signal, trusted capability, forged persistence, deterministic ID, duplicate observation,
  compact-marker replay, dark-workflow tests, lifecycle correlation, and a real browser process
  proof (`tests/browser/agent-resume-fallback.spec.ts`). No component-only test can substitute for
  the backend classifier, operation workflow, journal, and active composition proof
- managed agent and primary-shell restart proof must cross clean shutdown, abrupt process loss, and
  first upgrade. A clean shutdown may restore exactly one process at the next generation; an
  unclean absence, consumed/ambiguous permit, identity mismatch, or corrupt journal must bind no
  channel and create no process. Repeat the clean cycle to prove generation high-water advances,
  and exercise the canonical pre-journal migration once without turning later absence into another
  initial launch. Exact attach tests must also prove task/session/classification metadata is
  immutable on both success and mismatch
- browser scratch-shell attachment must cross initial creation, cleared creation intent, and reload
  of the same live process. Prove transport identity overrides forged body fields, authenticated
  observers attach without spawning, resizing, or transferring control, task/session/generation
  mismatches cannot bind, missing process/provenance cannot respawn from restore, and PTY exit retires
  provenance. Shared task auxiliary shells must retain their canonical
  membership semantics; client session-storage layout is not backend admission proof
- managed initial-prompt delivery needs exact-generation queue/write proof, missed-event safety
  observation for runtime discovery/readiness/post-write evidence, manual ambiguity and
  draft-conflict coverage, exact lost-response draft replay before one coalesced trailing edit,
  correlated facade responses, a real browser delivery journey, and its acknowledgement performance
  companion (`tests/browser/initial-prompt-delivery*.spec.ts`). Fresh artifacts must also keep the
  eager-main plus exact lazy-control gzip closure below its aggregate ceiling, keep the control chunk
  independently bounded, and prove it is not module-preloaded
- initial-prompt deadline tests must prove that no-session time is unbounded, the first admitted
  generation receives a full 45 seconds, only its first pre-write generation change extends that
  deadline, asynchronous draft/lease work cannot cross it, and the five-second verification window
  starts at actual write acceptance. They must also cover late absence without retry, missing-runtime
  `writing`/`retry-wait` recovery, transient journal/projection failures, queue-time projection
  failure, no-runtime queue and terminal publication retry after a throw or null projection without
  another status change, exact-once lease release with a rejected first release, and corrupt durable records
  (timestamps, deadline pairs, generation-scoped candidates, fingerprints, attempts/write intent,
  and sealed-state consistency)
- manual initial-prompt takeover tests must prove seal persistence precedes automatic-lease release,
  a rejected release resumes the same sealed operation without another automatic write, and a
  rejected manual-lease release is retried before replay without reacquisition or readmission. A
  concurrent replay must remain behind the in-flight delivery turn and cannot release its lease.
  Production persistence tests must prove one edit produces exactly one journal transition, exact
  replay preserves record bytes/version/storage generation, and accepted-send plus observed-send
  reconciliation preserve sealed edit high-water across restart. The record decoder must reject
  missing reverse indexes and phase/receipt contradictions. If accepted PTY bytes outlive a
  transient draft-clear failure, same-session background finalization must clear the exact operation
  with zero additional byte admissions; stale competing operations and a proof-to-temporary-gate
  race must reschedule rather than cancel it. Closing the runtime must cancel and await those probes
- initial-prompt presentation tests must compare operation identity to the acknowledged current
  draft. Failure followed by edit offers a fresh `send` with the revised fingerprint/revision and
  derived operation ID, never a retry action for the superseded operation; write-accepted and
  ambiguous outcomes remain blocking
- missing/invalid primary crossed with missing/invalid/stale/equal/higher temp and backup evidence;
  no test may assert automatic candidate promotion
- inactive and independently activated protected-policy fixtures, including stale-revision-before-
  forgery precedence, exact echo, omission, and difference
- the structural cutover stamps every immediately previous-schema task and the host writer epoch in
  one transaction, is idempotent without another generation, and re-reads the committed record
  before reopening admission
- current and stale full-save attempts cannot add/omit task IDs, smuggle membership through either
  order, replace a same-ID task root/location, or delete nested writer provenance; semantic add and
  remove each produce at most one shared commit and exact retries are unchanged
- closing, removing, and error presentation rows remain present in both app and shared persistence;
  tests must not use renderer lifecycle flags as proof of canonical removal
- typed-intent acknowledgement by operation ID or exact canonical result, bounded/coalesced queues,
  unrelated-field rebase, deterministic retirement plus a persistent notice for same-field conflicts
  and missing targets, and the absence of add/remove intent variants
- remote task-creation tests must vary `task:create-root`, `task:create-imported`, and
  `task:permission-bypass` independently. Assert both the returned capability and final create/picker
  admission, and prove the workflow is never called on denial
- Electron-hosted remote task-creation assembly proof must instantiate `startRemoteServer` with its
  real HTTPS/WSS transport, scoped session authority, command gateway, and operation-event adapter.
  Stub only the backend workflow; prove grant denial, capability non-echo, Issue/Create-or-status/
  Cancel, duplicate-effect safety, logout or equivalent revocation, and subscription cleanup
- desktop creation lost-response tests must prove the optimistic retry calls every location facade
  with the same `adapterOperationId`, while a separately admitted/changed submission gets a new ID;
  the trusted-local backend test then proves that ID replays one canonical operation/task. Workflow
  tests must also prove authorization/lookup throttling/journal readiness and known lookup precede
  every live selection read; a committed exact retry still replays after its project, agent, base
  branch, or existing worktree disappears; changed semantics still conflict; and an invalid fresh
  selection consumes bounded first-admission capacity while producing no journal, preparation,
  workspace, shell, or agent-session effect. Operation-event tests cover a silent pending
  pre-record subscription, post-durable publication, failed-write silence, bounded cleanup,
  unavailable-current silence, and refresh isolation across both principal and capability
- task-creation conflict tests must use the real serialized journal admission path: active and
  retained overlap reject before effects, restart rebuilds the same barriers, exact terminalization
  releases them, and unrelated resources still admit. Managed preparation tests must assert the
  pre-effect key contains the deterministic worktree path (plus its branch), that preparation
  rejects a changed plan before Git, and that commit ambiguity retains only keys declared by the
  original record
- production reconciliation proof must cover one composition-owned service and canonical snapshot
  projector, restart discovery, record-version CAS, content-free actor audit, malformed/forged actor
  rejection, exact mapping and absence classification, and retained-quarantine terminalization.
  List pagination must return `stale` after any candidate record version/set change. Electron tests
  must exercise the direct local handlers and browser facade fail-before-transport behavior; source
  guards must prove the channels are absent from shared HTTP, gateway, and WebSocket registration
- mapping-adoption tests must assert the next durable phase is recoverable
  `created-needs-attention`—agent mode with retry-launch metadata and terminal mode with projection
  repair—not `starting`. Unsupported restore/unlock/ref operations must remain proof-insufficient,
  with no filesystem or Git effect, until their exact production proof owner exists
- remote reload recovery must cover exact absence before expiry, denied Start-over, a second exact
  absence lookup after a full monotonic ticket-TTL wait, safe credential release despite forward
  browser wall-clock jumps, and the absence of raw ticket/prompt/intent text from session storage
- merge cutover proof must cover hashed server-issued access, lost-response Status recovery,
  pending-removal resume, lease loss before Git, finalizer repair, no caller paths, no renderer
  cleanup/deltas, creation-before-merge production activation, and projection after lease release
- D09 browser proof owns only browser-observable risk: real managed-worktree UI admission, every
  Start reply lost after one successful backend result, terminal Status join and credential release,
  two-client canonical removal/progress convergence, zero-line and no-cleanup semantics, public
  response redaction, one progress render batch per version, and a reconnect metadata delta below
  1 KiB. Deterministic backend suites remain the owner for exhaustive Git, fsync, crash-phase,
  cleanup-step, and finalizer fault matrices; do not duplicate those faults with Playwright timing
- run the D09 browser lanes with
  `npm run test:browser:file -- tests/browser/task-merge-progress.spec.ts --project chromium --workers=1`
  and
  `npm run test:browser:file -- tests/browser/task-merge-progress-performance.spec.ts --project chromium --workers=1`
- `npm run test:performance-gates:run` is the serial owner for every applicable active-design
  micro/resource/bundle gate: D01 initial delivery/readiness/bundle; D02 prompt policy, backend
  admission, agent-output activity, and bundle; D03 deterministic-owner and real-Git worktree
  links; D04 terminal-search bundle; D05 task-content-authority and wrapped-link mapping; D06 WebGL
  repair; D07 draft comparison; D08 Git-action capability; D09 merge reducer/workflow/bundle; D11
  session/recovery; D12 New Task default sampling; D13 catalog/gateway/remote-feature bundle; and
  D14 notes service/controller. Bundle checks require freshly compressed production artifacts.
  D10 has no independent microbenchmark because it adds no runtime loop: its reduced-motion/focus
  contract is owned by deterministic style tests and the active-feature browser lane. D14's
  performance gates exercise the implemented writer without promoting either production writer
  entitlement; only the separate exact clean-artifact proof may do that. Browser-observable
  performance companions remain in `test:browser:active-features`. D01/D11's shared reliability
  bundle proof traverses and deduplicates each lazy entry's complete static JavaScript closure and
  rejects preload/prefetch; measuring only the named entry is insufficient. Planned generic
  recovery-center and creation/removal/shell stress suites are not release proof until their
  executable files and commands are committed

Preferred proof:

- `node / backend` for parser, reconciliation, and lifecycle contracts
- real temporary-directory node tests for fsync-safe host storage and fault classification; mocked
  collaborator calls do not prove primary bytes, candidate preservation, or one-file migration
- adapter contract tests should run the same logical shared mutation against standalone and
  Electron, then compare decoded shared state/revision rather than disk layout bytes
- `runtime / integration` when reconnect/bootstrap ordering is part of the risk

### Review Diff Semantics And Performance

Validate these failure patterns:

- review and non-review surfaces load different diff sources for the same file
- committed review files accidentally fall back to worktree diff semantics
- tracked modified files return `oldContent` and `newContent` but an empty unified `diff`
- cold review file-list loads regress because backend changed-file enumeration adds whole-repo
  scans back into the hot path
- per-file review clicks regress because the backend fans one selection out into unnecessary git
  subprocesses
- worktree fallback stays stuck on branch truth after the worktree becomes available again
- async review/file-list refreshes accept stale completions after mode, branch, or worktree inputs
  change

Preferred proof:

- `node / backend` for:
  - changed-file status semantics
  - modified/add/delete/untracked diff correctness
  - merge-conflict status preservation
- `Solid / UI` for:
  - review surface routing
  - directory-path filtering
  - selected-file continuity
- manual profiler for hot-path latency:
  - `npm run profile:review:diffs -- --worktree-path <path>`
  - pass `--project-root` and `--branch-name` when you need committed branch-file timings too

When measuring review diff performance, record at least:

- cold `get_project_diff(all)` latency on a fresh server
- warm `get_project_diff(all)` latency
- cold per-file `get_file_diff` latency for a representative modified file
- warm per-file `get_file_diff` latency for the same file

### Replay, Reconnect, And Ordering

Validate these failure patterns:

- restore starts from transport-open instead of authenticated control truth
- stale snapshots overwrite newer live state
- reconnect restores the wrong category set or misses replayable state
- clear snapshots drop ordering truth and let older state reapply later
- cross-plane updates race because the backend did not carry sequence/version truth
- version-gated resync drift: a reconnecting client presents per-boot category versions against a
  different server instance, or a stale-category computation resends too little.
  `tests/contracts/delta-resync.contract.test.ts` is the lane: it asserts the < 5KB no-change
  blip byte budget at 12-task scale, stale-category-only resend, single `control-replay-batch`
  frame replay with wholesale `toSeq` adoption, ring compaction (one slot per entity key,
  tombstone supersession, and the `run-meta-upserted` per-run slot that keeps a blip-window
  meta mutation from superseding the run's creation snapshot), the instanceId-change
  full-bootstrap fallback, and the legacy-client full-bootstrap/per-event-replay lock; derive
  category counts from `SERVER_STATE_BOOTSTRAP_CATEGORIES`, never a literal. The wire seam for
  the resync fields (query params and auth-message fields into the parsed resync request) is
  locked positively in `server/browser-websocket.test.ts`, and the client-side instance-change
  tracker reset is locked in `src/app/server-state-bootstrap-registry.test.ts`
- `replay-truncated` no longer implies a full client restore (stale categories arrive through the
  version handshake); a mid-stream sequence gap still forces it, and the
  `GetBrowserReconnectStatus` mismatch path stays the recovery backstop — proven at
  `src/runtime/browser-session.runtime.test.ts` (no wall-clock warm window remains)
- a zombie-OPEN socket after sleep/wake must be detected by the wake liveness probe
  (`probeLiveness` cases in `src/lib/websocket-client.test.ts`), not by waiting out heartbeats
- related progress values must be tested as one full versioned projection, not as independent
  renderer deltas. For merged progress, prove zero-line counting, commit-date rollover, safe-integer
  overflow rejection, legacy seeding, same-operation idempotency, stale/equal-divergent renderer
  delivery, and the structural precondition that the task and both order lists are already absent
- keep the pure merge-progress proof separate from effectful removal qualification. The current dark
  foundation is covered by `src/domain/task-merge.test.ts`,
  `src/domain/task-merge.performance.test.ts`, `electron/ipc/merge-progress.test.ts`,
  `src/app/merge-progress.test.ts`, and the inactive-versus-active host policy/storage tests.
  Browser replay, two-client, cleanup, and finalizer tests become required only when the single
  generic removal owner and its activation epoch exist; a test-only cleanup substitute is not an
  acceptable enablement proof
- generic task-removal qualification must exercise the production cleanup-step participant, not an
  aggregate cleanup substitute. Prove that each completed step and its evidence survive restart,
  retry begins at the first unfinished step, canonical membership remains present while cleanup is
  pending, and absence commits before ordered finalizers. Include managed-terminal shell
  prepare/finalize identities and the committed workspace revision
- cover root-backed terminal and agent tasks in both Git-preserving and non-Git modes. Their frozen
  plans must never schedule worktree quarantine or branch release, and a restart/replay must not
  repeat already completed runtime effects
- cutover tests must hold an admitted legacy cleanup open while activation begins, then prove the
  activation waits, the legacy effect and canonical membership removal finish once, and the shared
  gate disables before the generic capability publishes. Handler tests must separately prove that
  active generic removal ignores renderer cleanup hints and does not invoke legacy workflows
- real-Git quarantine tests must preserve uncommitted bytes, refuse foreign/symlink recovery targets,
  replay the same operation, reject evidence from another operation, and refuse branch release
  after the ref moves. Recovery ownership witnesses must also survive strict creation-journal
  save/restart validation
- renderer close tests must treat `cleanup-pending` and `awaiting-linked-proof` as non-removal:
  retain the task, persist no local absence, and expose a retryable close error. `complete` and
  `finalizer-repair-pending` may remove the local projection because canonical absence has committed

Edge cases that are easy to miss:

- reconnect during active control
- stale-after-clear controller snapshots
- replay arriving while local optimistic state is still visible
- browser-session disposal before boot completes

Preferred proof:

- `node / backend` for snapshot/version/replay contracts
- `runtime / integration` when the browser reconnect path itself is under review

### Multi-Client Collaboration And Control

Validate these failure patterns:

- ownership is not exclusive
- controller snapshots apply too late or without version gating
- passive observers are prompted repeatedly instead of staying read-only
- takeover queues collapse to one request even though the owner keeps a queue
- task-command control and terminal input control are conflated
- disconnect or auth loss leaves retained lease state behind

Edge cases that are easy to miss:

- owner timeout auto-approval versus force takeover
- multiple simultaneous takeover requests
- reconnect during an outstanding takeover
- remote/mobile visibility hide-show cycles
- first-run remote session naming and submit-flow focus release

Preferred proof:

- `node / backend` for lease and controller semantics
- `runtime / integration` for real multi-client and remote/mobile browser behavior
- `Solid / UI` for read-only and takeover surface behavior inside one client

### Terminal Recovery, Focus, And Restore

Validate these failure patterns:

- `ready` is reported before restore, resize drain, or input drain actually complete
- delta/noop recovery accidentally enters the blocking snapshot lane
- historical output is replayed through the live stream on rebind
- background terminals steal focus while finishing startup
- attach priority or deferred startup makes the active terminal feel blocked
- redraw-heavy focused output exposes intermediate TUI frames because tiny control chunks bypass the
  queued/coalesced path
- hidden-terminal optimization looks great in steady state but makes task switches or wake/restore
  materially worse
- module-local startup or recovery owners recurse or leak state across tests

Edge cases that are easy to miss:

- typing during recovery, not only after visible readiness
- large-history background tab switches
- browser terminal background-switch contracts that only reproduce after heavy shared Chromium
  process churn
- hidden-tab browser tests that use direct backend writes must send them with the same session
  client id as the page under test, or the controller/focus behavior will not match real browser
  ownership
- hidden-to-visible task switches after long hidden verbose output
- reload/restore with warm scrollback
- focused typing while a background terminal redraws heavily
- ANSI/control sequences split across transport chunks
- startup failures that should clear shared progress state instead of leaving stale queued entries

Preferred proof:

- `node / backend` for recovery contract, retained-cursor behavior, and headless terminal-state
  stress against cursor-addressed TUI output
- `runtime / integration` for real browser restore/focus/render behavior
- `Solid / UI` for local terminal overlays and shared startup indicators

For output-path changes in the renderer terminal pacing path, also require:

- seam tests for split redraw-control sequences and split non-redraw ANSI sequences so chunk-boundary
  assumptions cannot silently corrupt bytes or bypass pacing
- seam tests that sustained suppressed output during render hibernation still reaches renderer-side
  flow-control pause behavior instead of bypassing backpressure
- a controlled real browser terminal workload before relying on a product-specific repro
- isolated browser-profiler passes when the target lifecycle can age out during a longer run

When the profiler waits for a selected or hidden terminal to become "ready", require a live-render
signal instead of only checking status text or visibility.

After `page.bringToFront()` in browser-lab terminal tests, reacquire terminal keyboard ownership
through the real terminal surface before typing. Do not rely on stale `document.activeElement`
state across hidden-tab round trips.

For flicker or replay regressions, use the deterministic render-stress browser harness before
tuning the runtime, then confirm the same user-visible bar in a real browser workload:

- no `restoring` status while the terminal is already live
- no snapshot recovery during ordinary visible steady state
- the terminal remains focusable and accepts input after resize/output churn
- resize diagnostics should show coalescing rather than one PTY resize per viewport twitch

When browser fluidity is the main concern, do not rely on one full-width viewport. Use a
visibility-shape sweep so the same workload is observed with different numbers of terminals in
view, because main-thread behavior can change materially as the visible set shrinks.

When reviewing a lane-specific visible scheduling change, add a browser suite that proves the lane
is actually active before using that run as a promotion gate.

### Preview, Ports, And Parser Trust

Validate these failure patterns:

- parser output is treated as canonical truth instead of a hint
- shell noise is stripped too aggressively and damages valid URLs
- preview routes lose auth, nested paths, or static assets
- task-owned observed ports and dialog-local scan suggestions get conflated
- preview state hides errors or trust boundaries behind density changes
- opening or focusing preview silently triggers whole-host candidate scans without an explicit
  workflow policy

Edge cases that are easy to miss:

- broken real-world strings next to nearby valid strings
- stale detected ports after task changes
- nested preview paths
- unauthorized and unavailable preview targets

Preferred proof:

- `node / backend` for parsing and routing semantics
- `Solid / UI` when the risk is presentation-only
- `runtime / integration` when auth/bootstrap and real browser navigation matter

### Handler, Typing, And Persistence Boundaries

Validate these failure patterns:

- required request payloads become optional for transport convenience
- optional request channels stop taking their intended default path
- malformed handler input is accepted too late
- shared payload shapes drift across backend, transport, and renderer copies
- persisted-state parsing forks into multiple local parsers
- mocked backend controller responses stop carrying version truth

Edge cases that are easy to miss:

- empty but valid fragments
- legacy agent definitions
- explicit `undefined` versus omitted payloads
- DOM-bearing modules becoming the accidental source of truth for shared types
- resume behavior inferred from args instead of the canonical agent definition

Preferred proof:

- `node / backend` boundary tests first

### High-Churn Product Screens

Validate these failure patterns:

- task, review, preview, or sidebar screens diverge from canonical store/projection owners
- dialogs or leaf chrome silently become task- or app-level workflow owners
- UI summaries drift from the shared projection model
- first-run or reopen flows work in isolation but fail in the full app shell
- sibling surfaces with the same user intent route through different backend/query paths
- local single-item actions silently trigger whole-project or whole-host work

Edge cases that are easy to miss:

- dialog reopen flows
- local sidebar chrome state persisting separately from shared workspace state
- selection and focus after pushed state changes
- read-only and takeover banners collapsing or re-expanding incorrectly
- review/comment/export workflows drifting across multiple surfaces
- TaskPanel permission flows regressing back into inline component orchestration
- ReviewPanel loading and file-selection state drifting back into direct transport handling

Preferred proof:

- `Solid / UI` first
- add `runtime / integration` when focus, browser bootstrap, or multi-client behavior matters
- add architecture tests whenever a shell component is supposed to remain a pure composition layer
- for sibling-surface drift, add at least one equivalence test or source-level guard proving the
  same intent stays on one canonical owner/query path

### Notification, Visibility, And Attention Routing

Validate these failure patterns:

- initial bootstrap or reconnect replay is treated like a fresh task-status transition
- notification policy drifts between Electron and browser providers
- browser permission or capability state is assumed instead of modeled explicitly
- same-browser tabs duplicate the same notification burst
- visible peers suppress too much or too little task attention
- hidden/browser-specific notification behavior is validated only in node tests

Edge cases that are easy to miss:

- browser permission moving through `default`, `granted`, and `denied`
- persisted notification preference migrating from older default-off state into the current
  default-on preference model
- Electron runtimes where native notifications are unsupported
- refocus or tab-visibility changes while notifications are still debounced
- multiple tasks becoming ready in one burst
- reconnect finishing while the notification runtime is still disarmed

Preferred proof:

- `Solid / UI` for provider capability state, permission flows, and shared notification runtime
- `Solid / UI` or session-state tests for toggle-on permission requests and legacy preference
  migration when browser defaults change
- `runtime / integration` when real browser visibility, multi-tab dedupe, or multi-client
  suppression is part of the risk
- `node / backend` only for the Electron IPC capability and delivery seam

## Harness Failure Patterns

Shared harnesses need explicit proof when they change. The common failure patterns are:

- timer state leaking across tests
- listener cleanup removing “the current listener for this event” instead of the exact listener
- readiness waits keying off incidental calls instead of the real completion signal
- retained sessions, retry queues, or subscriptions surviving across tests in module scope
- mocks collapsing backend truth to booleans and no longer exercising the real contract

The right fix is usually to improve the harness, not to broaden timeouts.

For terminal loading readiness, prefer structural signals over copy:

- `data-terminal-loading-overlay="true"` for “still masked/loading”
- `data-terminal-live-render-ready` for “safe to treat as visibly ready”
- `data-terminal-presentation-mode` for the current visible surface contract
- `data-terminal-status` only as phase/state metadata

Do not key browser readiness or churn checks off phase-specific loading text alone. Loading copy is
allowed to stabilize or change for UX reasons; the browser harness should prove the real visible
surface contract instead.

For terminal continuity regressions, assert presentation truth directly:

- `live` means the xterm surface is current and may accept stdin
- `loading` means the live xterm surface is masked and should not accept stdin
- visible `passive-visible` terminals should still remain on the real live terminal surface; use
  scheduler and pacing assertions for them, not masked-overlay assertions
- browser resize tests should prefer `data-terminal-presentation-mode` over inferring behavior from
  copy or surface tier alone
- background-tab restore/input regressions should stay on the real typed-input path; avoid
  “priming” the shell with direct control writes that can mask a first-command loss bug
- browser request-tracked terminal input tests should prove backend acceptance or rejection, not
  just that the websocket send resolved locally
- browser latency budgets that rely on terminal input tracing should warm tracing once and then
  reset diagnostics before the measured action, so clock alignment startup is not mistaken for
  input lag
- browser held-key latency tests should use repeated `keyboard.down(...)` plus one final
  `keyboard.up(...)` when they are meant to approximate auto-repeat semantics; repeated
  `keyboard.press(...)` is still useful, but it proves discrete taps instead of a held key
- browser multi-char typing latency tests should clear a shell prompt line after tracing warmup,
  when applicable, and they should keep exact batching-window policy assertions in unit/runtime
  seams because visible echo may appear incrementally even when one input batch was accepted
  immediately
- startup/reload benchmarks should distinguish logical ready from painted ready. If a benchmark opts
  out of `liveRenderReady`, label it as logical readiness and keep a separate visible paint metric

## Quality Gates

A change is not ready when it introduces any of these without matching proof:

- a new fallback without a recovery-path test
- a cache without tests for every correctness-relevant invalidation input
- a lifecycle step without a transition test
- a cross-seam user-visible flow without at least one runtime/browser scenario
- a terminal pacing/recovery change without split-chunk seam coverage

Required review questions:

1. Which state machine did this change touch?
2. Which transitions changed?
3. Which invariant would fail in production if this broke?
4. Which seam proves the failure path?
5. Which seam proves the recovery path?

## Implicit Edge Cases

When you validate a risky area, some edge cases should be treated as implicitly included in the
proof even if the change did not mention them by name.

Examples:

- a startup/persistence change implicitly includes legacy and partial persisted-state handling
- a browser restore change implicitly includes authenticated bootstrap ordering
- a controller or lease change implicitly includes stale-after-clear ordering and versioned mocks
- a remote/mobile collaboration change implicitly includes first-run naming and submit-focus
  release
- a terminal recovery change implicitly includes typing during recovery and large-history churn
- a task-content read change implicitly includes renderer-root substitution, lexical and symlink
  escapes, requested/canonical extension mismatch, descriptor replacement, exact/max-plus-one byte
  limits, close/delete between admission and descriptor bind, generation ABA, and descriptor cleanup
- a transient terminal-root change implicitly includes missing/mismatched/task-backed PTYs,
  invented or replayed Arena launch capabilities, PTY replacement/exit, kill/kill-all/termination
  with delayed process exit, Arena kill-before-worktree-removal ordering, and every intervening
  canonical unknown-to-known transition

If the chosen seam does not make those edge cases visible, add another seam.

## What To Update With The Code

If a change teaches a reusable testing lesson:

- update this document when the lesson is about failure patterns, seam choice, or what counts as
  sufficient proof
- update [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md) when the lesson is about
  browser-lab workflow, profiler usage, or terminal debugging order
- update [ARCHITECTURE.md](./ARCHITECTURE.md) when the lesson is really an ownership or guardrail
  constraint rather than a testing pattern

## Test Quality Bar

- Prefer one projection test plus one presentation smoke test over several component tests that all assert the same visible startup state.
- Prefer invariant assertions over full internal object snapshots unless the object shape is itself the contract.
- Use runtime seam tests and browser specs, not shallow component specs, as the primary protection for timing, recovery, resize, and terminal performance regressions.
